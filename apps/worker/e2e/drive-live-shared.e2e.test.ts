import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { rewriteLive } from "@omni/docs";
import { decodePresence, encodePresence } from "@omni/docs/presence";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { appendRaw } from "./live-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { pushFrame, CookieJar, signIn, WEB_ORIGIN } from "./support.ts";

const S2 = { url: "http://127.0.0.1:54380/v1", basin: "omni-docs-dev" };

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_ACTIONS: "off",
      RATE_LIMIT_STORAGE_LINK: "off",
      RATE_LIMIT_STORAGE_LINK_LIVE: "off",
      S2_BASIN_URL: S2.url,
      S2_BASIN: S2.basin,
    },
  });
}, 120_000);
afterAll(() => stack?.stop());

type Event = Record<string, unknown>;
const bytes = (text: string) => new TextEncoder().encode(text);
const base64 = (update: Uint8Array) => Buffer.from(update).toString("base64");

async function open(path: string, jar: CookieJar, extra: Record<string, string> = {}) {
  const url = new URL(path, stack.worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie: jar.header, origin: WEB_ORIGIN, ...extra },
  } as unknown as string[]);
  const received: Event[] = [];
  const waiters = new Set<() => void>();
  const closed = Promise.withResolvers<number>();
  socket.addEventListener("message", (e) => {
    pushFrame(received, e.data);
    for (const waiter of waiters) waiter();
  });
  socket.addEventListener("close", (e) => closed.resolve(e.code));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  const waitFor = (match: (event: Event) => boolean) => {
    const found = Promise.withResolvers<Event>();
    const check = () => {
      const event = received.find(match);
      if (event) found.resolve(event);
    };
    waiters.add(check);
    check();
    return found.promise.finally(() => waiters.delete(check));
  };
  let ref = 0;
  const send = async (record: Event, nodeId: string, matchSeqNum?: number) => {
    const sent = ++ref;
    socket.send(JSON.stringify({ type: "doc.append", nodeId, ref: sent, record, matchSeqNum }));
    return waitFor(
      (e) => (e.type === "doc.appended" || e.type === "doc.refused") && e.ref === sent,
    );
  };
  return { socket, received, waitFor, send, closed: closed.promise };
}

async function memberTab(person: Person, nodeId: string) {
  const tab = await open("/api/realtime", person.jar);
  tab.socket.send(JSON.stringify({ type: "file.presence", nodeId, state: "editing" }));
  const probe = { t: "fold", e: 0, cv: 0, s: 0 };
  await vi.waitFor(
    async () => expect(await tab.send(probe, nodeId, 1_000_000)).toMatchObject({ reason: "tail" }),
    { timeout: 10_000, interval: 100 },
  );
  const append = async (record: Event) => {
    const answer = await tab.send(record, nodeId);
    if (answer.type !== "doc.appended") throw new Error(`refused: ${String(answer.reason)}`);
    return answer.seqNum as number;
  };
  return { ...tab, append };
}

async function visitorPage(jar: CookieJar, shareId: string, nodeId: string) {
  const page = jar.store(
    await fetch(new URL(`/api/storage/shared/${shareId}?node=${nodeId}`, stack.worker.url), {
      headers: { cookie: jar.header },
    }),
  );
  const body = (await page.json()) as { live?: boolean };
  const read = await fetch(
    new URL(`/api/storage/shared/${shareId}/files/${nodeId}/live?from=latest`, stack.worker.url),
    { headers: { cookie: jar.header } },
  );
  const live = (await read.json()) as { entries: { seqNum: number; record: Event }[] };
  const doc = new Y.Doc();
  const seed = live.entries.find((entry) => entry.record.t === "seed")!;
  for (const entry of live.entries) {
    Y.applyUpdate(doc, Buffer.from(String(entry.record.u), "base64"));
  }
  const tab = await open(`/api/storage/shared/${shareId}/realtime?node=${nodeId}`, jar);
  return { ...tab, page: body, doc, epoch: seed.seqNum, live };
}

async function sharedDoc(text: string, role: "editor" | "commenter" | "viewer" = "editor") {
  const org = await stack.company(`shared-live-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes(text));
  const link = await stack.api(ana.jar, "PUT", `/nodes/${doc.id}/sharing/link`, {
    linkAccess: "anyone",
  });
  await stack.api(ana.jar, "PUT", `/nodes/${doc.id}/sharing/link`, { role });
  return { org, ana, doc, shareId: link.body.sharing.shareId as string };
}

test("a guest on an Editor link types with a member live, and the server says who typed", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Plan\n\nStep one");
  const guest = await visitorPage(new CookieJar(), shareId, doc.id);
  expect(guest.page.live).toBe(true);
  const tab = await memberTab(ana, doc.id);

  const typed = rewriteLive(guest.doc, "# Plan\n\nStep one, from the guest");
  const answer = await guest.send(
    { t: "update", e: guest.epoch, u: base64(typed), by: "m:x" },
    doc.id,
  );
  expect(answer.type).toBe("doc.appended");
  const heard = await tab.waitFor((e) => e.type === "doc.record" && e.seqNum === answer.seqNum);
  expect((heard.record as Event).by).toMatch(/^g:[A-Za-z0-9_-]{22}$/);

  const memberDoc = new Y.Doc();
  Y.applyUpdate(memberDoc, Y.encodeStateAsUpdate(guest.doc));
  const fromAna = rewriteLive(memberDoc, "# Plan\n\nStep one, from the guest, and Ana");
  const seqNum = await tab.append({ t: "update", e: guest.epoch, u: base64(fromAna) });
  const reached = await guest.waitFor((e) => e.type === "doc.record" && e.seqNum === seqNum);
  expect(reached.record).not.toHaveProperty("by");
  const folded = await tab.append({ t: "fold", e: guest.epoch, cv: 1, s: seqNum });
  await guest.waitFor((e) => e.type === "doc.record" && e.seqNum === folded);
  expect(JSON.stringify(guest.received)).not.toContain(ana.id);
  await appendRaw(doc.id, { t: "fold", e: guest.epoch, cv: 1, s: folded, by: `m:${ana.id}` });
  const read = await fetch(
    new URL(`/api/storage/shared/${shareId}/files/${doc.id}/live?from=latest`, stack.worker.url),
  );
  const { entries } = (await read.json()) as { entries: { record: Event }[] };
  expect(entries.some((entry) => entry.record.t === "fold")).toBe(true);
  expect(JSON.stringify(entries)).not.toContain(ana.id);

  for (const record of [
    { t: "seed", cv: 1, u: base64(Y.encodeStateAsUpdate(guest.doc)) },
    { t: "fold", e: guest.epoch, cv: 9, s: seqNum },
    { t: "snap", e: guest.epoch, s: seqNum, cv: 1, f: guest.epoch, u: base64(typed) },
  ]) {
    expect(await guest.send(record, doc.id)).toMatchObject({
      type: "doc.refused",
      reason: "read_only",
    });
  }
  const pasted = rewriteLive(guest.doc, `# Plan\n\n${"A long pasted paragraph. ".repeat(3000)}`);
  expect(pasted.length).toBeGreaterThan(64 * 1024);
  const big = await guest.send({ t: "update", e: guest.epoch, u: base64(pasted) }, doc.id);
  expect(big.type).toBe("doc.appended");
  guest.socket.close();
  tab.socket.close();
});

test("an outsider hears its own doc and nothing else of the workspace", async () => {
  const { org, ana, doc, shareId } = await sharedDoc("# A");
  const other = await stack.upload(ana.jar, { space: "shared" }, "b.md", bytes("# B"));
  const guest = await visitorPage(new CookieJar(), shareId, doc.id);
  const bea = await stack.member(org.id);
  const onB = await memberTab(bea, other.id);
  const onA = await memberTab(ana, doc.id);

  const bDoc = new Y.Doc();
  const bEpoch = await onB.append({ t: "seed", cv: 1, u: base64(rewriteLive(bDoc, "# B")) });
  await onB.append({ t: "update", e: bEpoch, u: base64(rewriteLive(bDoc, "# B, secret")) });
  await stack.upload(bea.jar, { space: "shared" }, "salaries.md", bytes("private"));
  onB.socket.send(JSON.stringify({ type: "file.presence", nodeId: other.id, state: "editing" }));
  const stray = rewriteLive(new Y.Doc(), "# B, from the guest");
  guest.socket.send(
    JSON.stringify({
      type: "doc.append",
      nodeId: other.id,
      ref: 7,
      record: { t: "update", e: bEpoch, u: base64(stray) },
    }),
  );
  guest.socket.send(JSON.stringify({ type: "file.presence", nodeId: other.id, state: "editing" }));

  const marker = rewriteLive(guest.doc, "# A, marker");
  const done = await guest.send({ t: "update", e: guest.epoch, u: base64(marker) }, doc.id);
  await onA.waitFor((e) => e.type === "doc.record" && e.seqNum === done.seqNum);
  expect(onB.received.some((e) => e.type === "doc.record" && e.nodeId === doc.id)).toBe(false);
  for (const event of guest.received) {
    expect(["doc.appended", "doc.record", "doc.presence", "doc.comments", "doc.access"]).toContain(
      event.type,
    );
    expect(event.nodeId).toBe(doc.id);
  }
  const heard = JSON.stringify(guest.received);
  for (const secret of [ana.id, bea.id, bea.email, other.id, "secret", "salaries"]) {
    expect(heard).not.toContain(secret);
  }
  const bLive = await stack.api(bea.jar, "GET", `/files/${other.id}/live`);
  expect(JSON.stringify(bLive.body)).not.toContain("from the guest");
  const outside = await fetch(
    new URL(`/api/storage/shared/${shareId}/files/${other.id}/live`, stack.worker.url),
  );
  expect(outside.status).toBe(404);
  for (const tab of [guest, onA, onB]) tab.socket.close();
});

test("the server names an outsider's cursor, and an outsider cannot take a member's", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Notes");
  const tab = await memberTab(ana, doc.id);
  const guest = await visitorPage(new CookieJar(), shareId, doc.id);
  const presence = (clientId: number, clock: number, state: Record<string, unknown>) =>
    base64(encodePresence([{ clientId, clock, state }]));

  tab.socket.send(
    JSON.stringify({
      type: "doc.presence",
      nodeId: doc.id,
      u: presence(111, 1, {
        user: { name: "Ana", image: "https://pic.test/ana.png" },
        cursor: { a: 1 },
      }),
    }),
  );
  const toGuest = await guest.waitFor((e) => e.type === "doc.presence");
  const [anaState] = decodePresence(Buffer.from(String(toGuest.u), "base64"))!;
  expect(anaState!.state).toEqual({
    user: { name: "Ana", slot: expect.any(Number), kind: "member" },
    cursor: { a: 1 },
  });

  guest.socket.send(
    JSON.stringify({
      type: "doc.presence",
      nodeId: doc.id,
      u: presence(222, 1, { user: { name: "Ana (admin)" }, cursor: { b: 2 }, extra: true }),
    }),
  );
  const toAna = await tab.waitFor((e) => e.type === "doc.presence");
  const [guestState] = decodePresence(Buffer.from(String(toAna.u), "base64"))!;
  expect(guestState!.clientId).toBe(222);
  expect(guestState!.state).toEqual({
    user: {
      name: expect.stringMatching(/^Guest [A-Z][a-z]+$/),
      slot: expect.any(Number),
      kind: "guest",
    },
    cursor: { b: 2 },
  });

  const jar = new CookieJar();
  const again = await visitorPage(jar, shareId, doc.id);
  again.socket.send(
    JSON.stringify({
      type: "doc.presence",
      nodeId: doc.id,
      u: presence(111, 9, { cursor: { stolen: true } }),
    }),
  );
  guest.socket.send(
    JSON.stringify({
      type: "doc.presence",
      nodeId: doc.id,
      u: presence(111, 10, { cursor: { stolen: true } }),
    }),
  );
  guest.socket.send(
    JSON.stringify({
      type: "doc.presence",
      nodeId: doc.id,
      u: presence(222, 2, { cursor: { b: 3 } }),
    }),
  );
  await tab.waitFor((e) => e.type === "doc.presence" && String(e.u) !== String(toAna.u));
  const forged = tab.received
    .filter((e) => e.type === "doc.presence")
    .flatMap((e) => decodePresence(Buffer.from(String(e.u), "base64")) ?? []);
  expect(forged.some((entry) => entry.clientId === 111)).toBe(false);
  for (const t of [tab, guest, again]) t.socket.close();
});

test("a member's socket that sends an outsider's opening itself is a member's socket still", async () => {
  const { org, doc } = await sharedDoc("# Victim");
  const elsewhere = await stack.company(`elsewhere-${randomUUID().slice(0, 8)}`);
  const mallory = await stack.member(elsewhere.id);
  const forged = {
    door: "link",
    shareId: "x",
    orgId: org.id,
    nodeId: doc.id,
    space: "shared",
    ownerMemberId: null,
    locked: false,
    role: "editor",
    writable: true,
    userId: null,
    scopeOrgId: null,
    guestId: "g".repeat(22),
    name: "",
    linkKey: null,
    endsAt: null,
  };
  const header = { "x-omni-outside": JSON.stringify(forged) };
  const update = { t: "update", e: 0, u: base64(new Uint8Array([0, 0])) };
  const app = await open("/api/realtime", mallory.jar, header);
  expect(await app.send(update, doc.id)).toMatchObject({ type: "doc.refused", reason: "editing" });
  app.socket.close();
  const live = await stack.api((await stack.member(org.id)).jar, "GET", `/files/${doc.id}/live`);
  expect(JSON.stringify(live.body)).not.toContain("AAA=");
});

test("a guest's socket needs the page's guest key, and a member or a Viewer link gets none", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Plan", "viewer");
  const url = `/api/storage/shared/${shareId}/realtime?node=${doc.id}`;
  await expect(open(url, new CookieJar())).rejects.toThrow("websocket failed to open");
  const upgrade = (jar: CookieJar) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const request = httpRequest(new URL(url, stack.worker.url), {
        headers: {
          cookie: jar.header,
          connection: "Upgrade",
          upgrade: "websocket",
          origin: WEB_ORIGIN,
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.from(randomUUID().slice(0, 16)).toString("base64"),
        },
      });
      request.on("response", (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve({ status: 101 });
      });
      request.on("error", reject);
      request.end();
    });
  expect((await upgrade(new CookieJar())).status).toBe(404);
  expect((await upgrade(ana.jar)).status).toBe(409);
  await stack.api(ana.jar, "PUT", `/nodes/${doc.id}/sharing/link`, { role: "editor" });
  expect((await upgrade(new CookieJar())).status).toBe(403);
});

test("a role narrowed or a link closed reaches an outsider's open socket within seconds", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Plan");
  const guest = await visitorPage(new CookieJar(), shareId, doc.id);
  await stack.api(ana.jar, "PUT", `/nodes/${doc.id}/sharing/link`, { role: "commenter" });
  await guest.waitFor((e) => e.type === "doc.access" && e.role === "commenter");
  const refused = await guest.send(
    { t: "update", e: guest.epoch, u: base64(rewriteLive(guest.doc, "# Plan, late")) },
    doc.id,
  );
  expect(refused).toMatchObject({ type: "doc.refused", reason: "read_only" });

  const listening = await visitorPage(new CookieJar(), shareId, doc.id);
  const started = Date.now();
  await stack.api(ana.jar, "PUT", `/nodes/${doc.id}/sharing/link`, { linkAccess: "restricted" });
  const cut = (e: Event) => e.type === "doc.access" && e.role === null;
  await Promise.all([listening.waitFor(cut), guest.waitFor(cut)]);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await listening.closed).toBe(4403);
  expect(await guest.closed).toBe(4403);
});

test("a grantee joins through their grant, and a removed grant closes their socket", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Plan", "viewer");
  const email = `grantee-${randomUUID().slice(0, 8)}@outside.test`;
  await stack.api(ana.jar, "PUT", `/nodes/${doc.id}/sharing/people/${email}`, { role: "editor" });
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, email, jar);
  const grantee = await visitorPage(jar, shareId, doc.id);
  const tab = await memberTab(ana, doc.id);
  const answer = await grantee.send(
    { t: "update", e: grantee.epoch, u: base64(rewriteLive(grantee.doc, "# Plan, granted")) },
    doc.id,
  );
  expect(answer.type).toBe("doc.appended");
  const heard = await tab.waitFor((e) => e.type === "doc.record" && e.seqNum === answer.seqNum);
  expect((heard.record as Event).by).toMatch(/^u:/);
  await stack.api(ana.jar, "DELETE", `/nodes/${doc.id}/sharing/people/${email}`);
  await grantee.waitFor((e) => e.type === "doc.access" && e.role === null);
  expect(await grantee.closed).toBe(4403);
  tab.socket.close();
});

test("a guest's typing with nobody else on the doc is saved, as the guest's, once", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Plan\n\nOne");
  const guest = await visitorPage(new CookieJar(), shareId, doc.id);
  const text = "# Plan\n\nOne, and two from the guest";
  await guest.send(
    { t: "update", e: guest.epoch, u: base64(rewriteLive(guest.doc, text)) },
    doc.id,
  );
  await vi.waitFor(
    async () => expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(text),
    { timeout: 15_000, interval: 250 },
  );
  const versions = await stack.api(ana.jar, "GET", `/files/${doc.id}/versions`);
  expect(versions.body.current).toMatchObject({
    writtenByGuest: true,
    writtenByName: expect.stringMatching(/^Guest /),
    coauthors: [{ kind: "guest", name: expect.stringMatching(/^Guest /) }],
  });
  const fold = await guest.waitFor(
    (e) => e.type === "doc.record" && (e.record as Event).t === "fold",
  );
  expect(fold.record).toMatchObject({ t: "fold", e: guest.epoch, cv: 2 });
  await vi.waitFor(async () => {
    const live = await stack.api(ana.jar, "GET", `/files/${doc.id}/live`);
    const folds = (live.body.entries as { record: Event }[]).filter((e) => e.record.t === "fold");
    expect(folds).toHaveLength(1);
  });
  guest.socket.close();
});

test("a save holding a guest's and a member's typing is the member's when they typed last, and names the guest", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Plan");
  const guest = await visitorPage(new CookieJar(), shareId, doc.id);
  const tab = await memberTab(ana, doc.id);
  const typed = rewriteLive(guest.doc, "# Plan, from the guest");
  await guest.send({ t: "update", e: guest.epoch, u: base64(typed) }, doc.id);
  const anaDoc = new Y.Doc();
  Y.applyUpdate(anaDoc, Y.encodeStateAsUpdate(guest.doc));
  const both = "# Plan, from the guest, and from Ana";
  await tab.append({ t: "update", e: guest.epoch, u: base64(rewriteLive(anaDoc, both)) });
  await vi.waitFor(
    async () => expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(both),
    { timeout: 15_000, interval: 250 },
  );
  const versions = await stack.api(ana.jar, "GET", `/files/${doc.id}/versions`);
  expect(versions.body.current).toMatchObject({
    writtenByName: ana.email,
    writtenByGuest: false,
    coauthors: [{ kind: "guest", name: expect.stringMatching(/^Guest /) }],
  });
  guest.socket.close();
  tab.socket.close();
});

test("an outsider's update naming another epoch, or not a Yjs update at all, is refused, and the doc still opens and saves", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Plan");
  const guest = await visitorPage(new CookieJar(), shareId, doc.id);
  const forged = {
    t: "update",
    e: Number.MAX_SAFE_INTEGER,
    u: base64(rewriteLive(guest.doc, "# Plan!")),
  };
  expect(await guest.send(forged, doc.id)).toMatchObject({ type: "doc.refused", reason: "tail" });
  const truncated = { t: "update", e: guest.epoch, u: "AA==" };
  expect(await guest.send(truncated, doc.id)).toMatchObject({
    type: "doc.refused",
    reason: "read_only",
  });
  const text = "# Plan, still saved";
  const fresh = new Y.Doc();
  for (const entry of guest.live.entries)
    Y.applyUpdate(fresh, Buffer.from(String(entry.record.u), "base64"));
  await guest.send({ t: "update", e: guest.epoch, u: base64(rewriteLive(fresh, text)) }, doc.id);
  await vi.waitFor(
    async () => expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(text),
    { timeout: 15_000, interval: 250 },
  );
  guest.socket.close();
});

test("a doc only a guest types in gets snaps from the Worker's saves", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Notes");
  const guest = await visitorPage(new CookieJar(), shareId, doc.id);
  const typing = Array.from({ length: 205 }, (_, i) =>
    base64(rewriteLive(guest.doc, `# Notes\n\nLine ${i + 1}`)),
  );
  for (const u of typing) {
    await vi.waitFor(
      async () =>
        expect(await guest.send({ t: "update", e: guest.epoch, u }, doc.id)).toMatchObject({
          type: "doc.appended",
        }),
      { timeout: 10_000, interval: 250 },
    );
  }
  await vi.waitFor(
    async () => {
      const live = await stack.api(ana.jar, "GET", `/files/${doc.id}/live?from=latest`);
      const records = (live.body.entries as { record: Event }[]).map((entry) => entry.record);
      expect(records).toContainEqual(expect.objectContaining({ t: "snap", e: guest.epoch }));
    },
    { timeout: 20_000, interval: 500 },
  );
  expect(await (await stack.download(ana.jar, doc.id)).text()).toBe("# Notes\n\nLine 205");
  guest.socket.close();
});

test("a guest's comment on a Commenter link reaches everyone on the doc live", async () => {
  const { ana, doc, shareId } = await sharedDoc("# Plan", "commenter");
  const jar = new CookieJar();
  const guest = await visitorPage(jar, shareId, doc.id);
  const tab = await memberTab(ana, doc.id);
  const posted = await fetch(
    new URL(`/api/storage/shared/${shareId}/files/${doc.id}/comments`, stack.worker.url),
    {
      method: "POST",
      headers: { cookie: jar.header, "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ body: "Typo in the title" }),
    },
  );
  expect(posted.status).toBe(201);
  expect(await posted.json()).toMatchObject({ comment: { authorGuest: true, mine: true } });
  await tab.waitFor((e) => e.type === "doc.comments" && e.nodeId === doc.id);
  const typed = await guest.send(
    { t: "update", e: guest.epoch, u: base64(rewriteLive(guest.doc, "# Plan!")) },
    doc.id,
  );
  expect(typed).toMatchObject({ type: "doc.refused", reason: "read_only" });
  const comments = await stack.api(ana.jar, "GET", `/files/${doc.id}/comments`);
  expect(comments.body.comments[0]).toMatchObject({
    body: "Typo in the title",
    authorGuest: true,
    mine: false,
  });
  guest.socket.close();
  tab.socket.close();
});
