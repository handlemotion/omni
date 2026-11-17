// "Ana is editing" (ADR 0043 decision 3) through the real Worker and its realtime Durable
// Object: who hears it, that it survives hibernation, and that it clears when the app closes.
// And the live document those editors share (step 2), on the local stack's s2-lite.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN, type CookieJar } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { S2_BASIN_URL: "http://127.0.0.1:8090/v1", S2_BASIN: "omni-docs-dev" },
  });
});
afterAll(() => stack?.stop());

const bytes = (text: string) => new TextEncoder().encode(text);

/** The web app's realtime socket for `jar`, collecting what arrives. */
async function connect(jar: CookieJar) {
  const url = new URL("/api/realtime", stack.worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie: jar.header, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    received.push(JSON.parse(String(e.data)));
    for (const waiter of waiters) waiter();
  });
  /** Resolves with the first event `match` finds, once one has arrived. */
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
    /** The answer to this socket's append `ref` on `nodeId`. */
    answer: (nodeId: string, ref: number) =>
      waitFor(() =>
        received.find(
          (e) =>
            (e.type === "doc.appended" || e.type === "doc.refused") &&
            e.nodeId === nodeId &&
            e.ref === ref,
        ),
      ),
    /** The first event `match` finds, once one has arrived. */
    waitFor: (match: (event: Record<string, unknown>) => boolean) =>
      waitFor(() => received.find(match)),
  };
}

// Catches: an editing claim on a file the member cannot reach (it names the file to people who
// cannot see it, or tells its owner a stranger has it open), presence lost when the object
// hibernates (a second editor never learns the first is there), and a closed app that stays
// "editing" on everyone's screen.
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
  // Kept on Ana's socket, not in memory: a hibernated object still knows she is there.
  await stack.worker.server
    .getWorker()
    .evictDurableObject("Realtime", { name: org.id, webSockets: "hibernate" });
  boHears.editing(doc.id, "editing");
  expect(await boHears.next(2)).toEqual([at(ana.id, "editing"), at(ana.id, "editing")]);
  expect(await anaHears.next(1)).toEqual([at(bo.id, "editing")]);

  // Bo's My files are his: Ana's claim to edit his file is dropped, and he hears nothing of it.
  anaHears.editing(bos.id, "editing");

  // Bo hears Ana leave next, and nothing of the claim she made before it.
  anaHears.socket.close();
  expect((await boHears.next(3))[2]).toEqual(at(ana.id, "left"));
  expect(boHears.received).toHaveLength(3);
  boHears.socket.close();
});

// Catches: an `editing` whose access check finishes after the app already sent `left` (closed
// the editor), which would show the member editing a file they have closed until they reconnect.
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
  anaHears.editing(doc.id, "editing");
  anaHears.editing(doc.id, "left");

  // A later heartbeat and close still land as usual, and they are all Bo hears: the first check
  // started before them, so had it outlived the left it would have reached him first.
  anaHears.editing(doc.id, "editing");
  expect(await boHears.next(1)).toEqual([at("editing")]);
  anaHears.editing(doc.id, "left");
  expect(await boHears.next(2)).toEqual([at("editing"), at("left")]);
  anaHears.socket.close();
  boHears.socket.close();
});

// Catches: a socket that appends to a file's live document without the access check its
// `editing` made (anyone in the workspace writing into a file they cannot see), a record the
// other editors never hear (or that reaches a socket not editing the file), and two editors
// both seeding the document when they open it at once (the stream's tail is the referee), and an
// editor who lost access while the file was open still writing into it.
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

  // Not editing it yet: refused.
  anaSocket.append(doc.id, 1, seed, 0);
  await anaSocket.answer(doc.id, 1);
  expect(ofDoc(anaSocket.received)).toEqual([
    { type: "doc.refused", nodeId: doc.id, ref: 1, reason: "editing" },
  ]);
  // Editing Bo's own file, which she cannot see, is never checked: still refused.
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

  // Both open the editor at once and seed: the first takes the tail, the second is told so. Each
  // hears the other only once that one's access check passed.
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

  // Bo's update reaches Ana, not Cy, who sees the file but is not editing it.
  const update = { t: "update", e: 0, u: "AQ==" };
  boSocket.append(doc.id, 2, update);
  expect(await anaSocket.waitFor((e) => e.type === "doc.record" && e.seqNum === 1)).toEqual({
    type: "doc.record",
    nodeId: doc.id,
    seqNum: 1,
    record: update,
  });
  // What a socket missed is read over HTTP, by anyone who sees the file.
  expect((await stack.api(cy.jar, "GET", `/files/${doc.id}/live?from=1`)).body).toEqual({
    enabled: true,
    entries: [{ seqNum: 1, record: update }],
    more: false,
  });
  // Ana heard it before that round trip began, so a copy sent to Cy would be here by now.
  expect(ofDoc(cySocket.received)).toEqual([]);
  expect((await stack.api(ana.jar, "GET", `/files/${bos.id}/live`)).status).toBe(404);

  // Ana takes the file into her My files while Bo still has it open: once his check is stale,
  // his next record is refused for good, and nothing of his reaches her document. Until then
  // each record he sends expects a position the stream is not at, so none of them is written.
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
