import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authPost,
  CookieJar,
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorker,
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

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/talk${path}`, worker.url), {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function connect(cookie: string, options: { talk?: boolean } = {}) {
  const url = new URL("/api/realtime", worker.url);
  url.protocol = "ws:";
  if (options.talk !== false) url.searchParams.set("talk", "1");
  const socket = new WebSocket(url, {
    headers: { cookie, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    received.push(JSON.parse(String(e.data)));
    for (const waiter of waiters) waiter();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  const talk = () => received.filter((e) => String(e.type).startsWith("talk."));
  return {
    socket,
    talk,
    async until(match: (e: Record<string, unknown>) => boolean) {
      const found = Promise.withResolvers<Record<string, unknown>>();
      const check = () => {
        const hit = received.find(match);
        if (hit) found.resolve(hit);
      };
      waiters.add(check);
      check();
      return found.promise.finally(() => waiters.delete(check));
    },
  };
}

async function workspace(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  const people = {} as Record<"ana" | "ben" | "cy", { id: string; email: string; cookie: string }>;
  for (const name of ["ana", "ben", "cy"] as const) {
    const email = `${name}@${slug}.test`;
    const member = await createMember(db, org.id, email);
    people[name] = { id: member.id, email, cookie: await signIn(worker, db, email) };
  }
  return { org, ...people };
}

function jarOf(cookie: string) {
  const jar = new CookieJar();
  for (const pair of cookie.split("; ")) {
    const at = pair.indexOf("=");
    jar.cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return jar;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("a note reaches the two in the thread, and nobody else in the workspace", async () => {
  const { ana, ben, cy } = await workspace("talk-deliver");
  const anaSocket = await connect(ana.cookie);
  const benSocket = await connect(ben.cookie);
  const cySocket = await connect(cy.cookie);

  const opened = await api(ana.cookie, "POST", "/threads", { memberId: ben.id });
  expect(opened.status).toBe(201);
  const threadId = opened.body.thread.id;
  expect((await api(ben.cookie, "POST", "/threads", { memberId: ana.id })).body.thread.id).toBe(
    threadId,
  );

  const sent = await api(ana.cookie, "POST", `/threads/${threadId}/messages`, {
    body: "Dropping the deck now",
  });
  expect(sent.status).toBe(201);
  const isNote = (e: Record<string, unknown>) =>
    e.type === "talk.message" && e.messageId === sent.body.message.id;
  expect(await benSocket.until(isNote)).toEqual({
    type: "talk.message",
    threadId,
    messageId: sent.body.message.id,
    fromMemberId: ana.id,
    preview: "Dropping the deck now",
    message: sent.body.message,
  });
  await anaSocket.until(isNote);
  await settle();
  expect(cySocket.talk().filter((e) => e.type !== "talk.online")).toEqual([]);

  const people = await api(ben.cookie, "GET", "/people");
  const fromAna = people.body.people.find((p: { memberId: string }) => p.memberId === ana.id);
  expect(fromAna).toMatchObject({ threadId, unread: 1, online: true });
  expect((await api(ben.cookie, "PUT", `/threads/${threadId}/read`)).status).toBe(204);
  const after = await api(ben.cookie, "GET", "/people");
  expect(after.body.people.find((p: { memberId: string }) => p.memberId === ana.id).unread).toBe(0);

  expect((await api(cy.cookie, "GET", `/threads/${threadId}/messages`)).status).toBe(404);
  const cyPeople = await api(cy.cookie, "GET", "/people");
  expect(cyPeople.body.people.map((p: { threadId: string | null }) => p.threadId)).toEqual([
    null,
    null,
  ]);
  for (const s of [anaSocket, benSocket, cySocket]) s.socket.close();
});

test("someone outside the workspace never reads, writes or reacts in a thread", async () => {
  const { ana, ben } = await workspace("talk-outside");
  const outsiders = await createOrg(database.db, "talk-outsiders");
  await createMember(database.db, outsiders.id, "eve@talk-outsiders.test");
  const eve = await signIn(worker, database.db, "eve@talk-outsiders.test");
  const threadId = (await api(ana.cookie, "POST", "/threads", { memberId: ben.id })).body.thread.id;
  const note = await api(ana.cookie, "POST", `/threads/${threadId}/messages`, { body: "private" });
  const messageId = note.body.message.id;

  expect((await api(eve, "POST", "/threads", { memberId: ana.id })).status).toBe(404);
  expect((await api(eve, "GET", `/threads/${threadId}/messages`)).status).toBe(404);
  expect((await api(eve, "POST", `/threads/${threadId}/messages`, { body: "hi" })).status).toBe(
    404,
  );
  expect((await api(eve, "PUT", `/threads/${threadId}/read`)).status).toBe(404);
  expect(
    (await api(eve, "PUT", `/messages/${messageId}/reactions/${encodeURIComponent("👍")}`)).status,
  ).toBe(404);
  const dropped = await fetch(
    new URL(`/api/talk/threads/${threadId}/files?name=x.txt`, worker.url),
    {
      method: "POST",
      headers: { cookie: eve, "content-type": "text/plain" },
      body: "x",
    },
  );
  expect(dropped.status).toBe(404);
  const messages = await api(ben.cookie, "GET", `/threads/${threadId}/messages`);
  expect(messages.body.messages.map((m: { body: string }) => m.body)).toEqual(["private"]);
});

test("a dropped file lands in the sender's Drive, shared with the recipient and nobody else", async () => {
  const { ana, ben, cy } = await workspace("talk-file");
  const benSocket = await connect(ben.cookie);
  const threadId = (await api(ana.cookie, "POST", "/threads", { memberId: ben.id })).body.thread.id;
  const bytes = new TextEncoder().encode("Q3 numbers, final");

  const dropped = await fetch(
    new URL(`/api/talk/threads/${threadId}/files?name=${encodeURIComponent("q3.txt")}`, worker.url),
    { method: "POST", headers: { cookie: ana.cookie, "content-type": "text/plain" }, body: bytes },
  );
  expect(dropped.status).toBe(201);
  const { message } = (await dropped.json()) as {
    message: { id: string; file: { nodeId: string; name: string; size: number } };
  };
  expect(message.file).toMatchObject({
    name: "q3.txt",
    size: bytes.length,
    mimeType: "text/plain",
  });
  await benSocket.until((e) => e.type === "talk.message" && e.preview === "q3.txt");

  const { db } = database;
  const [node] = await db
    .select()
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.id, message.file.nodeId));
  expect(node).toMatchObject({ space: "personal", ownerMemberId: ana.id, kind: "file" });
  const [folder] = await db
    .select()
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.id, node!.parentId!));
  expect(folder).toMatchObject({ name: "Talk", kind: "folder", ownerMemberId: ana.id });
  const grants = await db
    .select({ email: schema.storageGrants.email, role: schema.storageGrants.role })
    .from(schema.storageGrants)
    .where(eq(schema.storageGrants.nodeId, node!.id));
  expect(grants).toEqual([{ email: ben.email, role: "viewer" }]);

  const open = (cookie: string) =>
    fetch(new URL(`/api/talk/messages/${message.id}/file`, worker.url), { headers: { cookie } });
  for (const person of [ben, ana]) {
    const got = await open(person.cookie);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  }
  expect((await open(cy.cookie)).status).toBe(404);

  await db
    .delete(schema.storageGrants)
    .where(
      and(eq(schema.storageGrants.nodeId, node!.id), eq(schema.storageGrants.email, ben.email)),
    );
  expect((await open(ben.cookie)).status).toBe(404);

  const second = await fetch(
    new URL(`/api/talk/threads/${threadId}/files?name=b.txt`, worker.url),
    {
      method: "POST",
      headers: { cookie: ana.cookie, "content-type": "text/plain" },
      body: "b",
    },
  );
  expect(second.status).toBe(201);
  const talkFolders = await db
    .select()
    .from(schema.storageNodes)
    .where(
      and(eq(schema.storageNodes.ownerMemberId, ana.id), eq(schema.storageNodes.kind, "folder")),
    );
  expect(talkFolders.map((f) => f.name)).toEqual(["Talk"]);
  benSocket.socket.close();
});

test("teammates hear who comes online and goes; a freelancer is neither seen nor told", async () => {
  const { ana, ben, cy } = await workspace("talk-online");
  await database.db
    .update(schema.members)
    .set({ role: "freelancer" })
    .where(eq(schema.members.id, cy.id));
  const anaSocket = await connect(ana.cookie);
  const cySocket = await connect(cy.cookie);
  const benElsewhere = await connect(ben.cookie, { talk: false });
  const benFirst = await connect(ben.cookie);
  await anaSocket.until(
    (e) => e.type === "talk.online" && e.memberId === ben.id && e.online === true,
  );
  const benSecond = await connect(ben.cookie);

  const people = await api(ana.cookie, "GET", "/people");
  const online = Object.fromEntries(
    people.body.people.map((p: { memberId: string; online: boolean }) => [p.memberId, p.online]),
  );
  expect(online).toEqual({ [ben.id]: true });
  expect(anaSocket.talk().filter((e) => e.memberId === ben.id)).toHaveLength(1);
  const threadId = (await api(ana.cookie, "POST", "/threads", { memberId: ben.id })).body.thread.id;
  await api(ana.cookie, "POST", `/threads/${threadId}/messages`, { body: "here?" });
  await benFirst.until((e) => e.type === "talk.message");
  expect(benElsewhere.talk()).toEqual([]);
  expect((await api(cy.cookie, "GET", "/people")).status).toBe(404);

  benFirst.socket.close();
  await settle();
  expect(anaSocket.talk().filter((e) => e.memberId === ben.id && e.online === false)).toEqual([]);
  benSecond.socket.close();
  benElsewhere.socket.close();
  await anaSocket.until(
    (e) => e.type === "talk.online" && e.memberId === ben.id && e.online === false,
  );
  expect(anaSocket.talk().some((e) => e.memberId === cy.id)).toBe(false);
  expect(cySocket.talk()).toEqual([]);
  anaSocket.socket.close();
  cySocket.socket.close();
});

test("reactions reach both and come back on the note", async () => {
  const { ana, ben } = await workspace("talk-react");
  const anaSocket = await connect(ana.cookie);
  const threadId = (await api(ana.cookie, "POST", "/threads", { memberId: ben.id })).body.thread.id;
  const note = await api(ana.cookie, "POST", `/threads/${threadId}/messages`, { body: "shipped" });
  const path = `/messages/${note.body.message.id}/reactions/${encodeURIComponent("🎉")}`;
  expect((await api(ben.cookie, "PUT", path)).status).toBe(204);
  const changed = await anaSocket.until(
    (e) => e.type === "talk.changed" && e.threadId === threadId,
  );
  expect(changed.reactions).toEqual({
    messageId: note.body.message.id,
    reactions: [{ emoji: "🎉", memberIds: [ben.id] }],
    version: 1,
  });
  const page = await api(ana.cookie, "GET", `/threads/${threadId}/messages`);
  expect(page.body.messages[0].reactions).toEqual([{ emoji: "🎉", memberIds: [ben.id] }]);
  expect(
    (await api(ben.cookie, "PUT", `/messages/${note.body.message.id}/reactions/ok`)).status,
  ).toBe(400);
  anaSocket.socket.close();
});

test("a drop never lands in a Talk folder the sender shared with someone else", async () => {
  const { ana, ben, cy } = await workspace("talk-shared-folder");
  const threadId = (await api(ana.cookie, "POST", "/threads", { memberId: ben.id })).body.thread.id;
  const drop = async (name: string) => {
    const response = await fetch(
      new URL(`/api/talk/threads/${threadId}/files?name=${name}`, worker.url),
      {
        method: "POST",
        headers: { cookie: ana.cookie, "content-type": "text/plain" },
        body: name,
      },
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { message: { file: { nodeId: string } } }).message.file
      .nodeId;
  };
  const { db } = database;
  const parentOf = async (nodeId: string) =>
    (await db.select().from(schema.storageNodes).where(eq(schema.storageNodes.id, nodeId)))[0]!
      .parentId!;

  const firstFolder = await parentOf(await drop("first.txt"));
  const [folder] = await db
    .select()
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.id, firstFolder));
  await db.insert(schema.storageGrants).values({
    orgId: folder!.orgId,
    nodeId: firstFolder,
    email: cy.email,
    role: "viewer",
    createdAt: new Date(),
  });

  const secondFolder = await parentOf(await drop("second.txt"));
  expect(secondFolder).not.toBe(firstFolder);
  const inherited = await db
    .select()
    .from(schema.storageGrants)
    .where(eq(schema.storageGrants.nodeId, secondFolder));
  expect(inherited).toEqual([]);
  expect(await parentOf(await drop("third.txt"))).toBe(secondFolder);
});

test("a file reaches a recipient whose session is held to the workspace by their company address", async () => {
  const { db } = database;
  const { org, ana, ben } = await workspace("talk-scope");
  const company = `scoped-${org.id.slice(0, 8)}.test`;
  const work = `ben@${company}`;
  await db.insert(schema.mailDomains).values({ orgId: org.id, domain: company, provider: "imap" });
  const [member] = await db.select().from(schema.members).where(eq(schema.members.id, ben.id));
  await db
    .insert(schema.userEmails)
    .values({ userId: member!.userId, email: work, verifiedAt: new Date() });
  const held = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, member!.userId));
  await db
    .insert(schema.sessionScopes)
    .values(held.map((s) => ({ sessionId: s.id, orgId: org.id })));

  const threadId = (await api(ana.cookie, "POST", "/threads", { memberId: ben.id })).body.thread.id;
  const dropped = await fetch(
    new URL(`/api/talk/threads/${threadId}/files?name=brief.txt`, worker.url),
    { method: "POST", headers: { cookie: ana.cookie, "content-type": "text/plain" }, body: "go" },
  );
  expect(dropped.status).toBe(201);
  const { message } = (await dropped.json()) as {
    message: { id: string; file: { nodeId: string } };
  };
  const grants = await db
    .select({ email: schema.storageGrants.email })
    .from(schema.storageGrants)
    .where(eq(schema.storageGrants.nodeId, message.file.nodeId));
  expect(grants).toEqual([{ email: work }]);
  const got = await fetch(new URL(`/api/talk/messages/${message.id}/file`, worker.url), {
    headers: { cookie: ben.cookie },
  });
  expect(got.status).toBe(200);
  expect(await got.text()).toBe("go");
});

test("a member removed from the workspace stops hearing it, and the others see them go", async () => {
  const { db } = database;
  const { org, ana, cy } = await workspace("talk-removed");
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, ana.id));
  const owner = jarOf(ana.cookie);
  const anaSocket = await connect(ana.cookie);
  const cySocket = await connect(cy.cookie);
  await anaSocket.until(
    (e) => e.type === "talk.online" && e.memberId === cy.id && e.online === true,
  );
  const closed = new Promise<number>((resolve) =>
    cySocket.socket.addEventListener("close", (e) => resolve(e.code)),
  );

  const removed = await authPost(worker, owner, "/organization/remove-member", {
    memberIdOrEmail: cy.email,
    organizationId: org.id,
  });
  expect(removed.status).toBe(200);
  expect(await closed).toBe(4403);
  await anaSocket.until(
    (e) => e.type === "talk.online" && e.memberId === cy.id && e.online === false,
  );
  expect(
    (await api(ana.cookie, "GET", "/people")).body.people.map(
      (p: { memberId: string }) => p.memberId,
    ),
  ).not.toContain(cy.id);
  anaSocket.socket.close();
});

test("a teammate made a freelancer stops hearing Talk on the socket they already had open", async () => {
  const { db } = database;
  const { org, ana, cy } = await workspace("talk-demoted");
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, ana.id));
  const owner = jarOf(ana.cookie);
  const anaSocket = await connect(ana.cookie);
  const cySocket = await connect(cy.cookie);
  await anaSocket.until(
    (e) => e.type === "talk.online" && e.memberId === cy.id && e.online === true,
  );
  const closed = new Promise<number>((resolve) =>
    cySocket.socket.addEventListener("close", (e) => resolve(e.code)),
  );

  const changed = await authPost(worker, owner, "/organization/update-member-role", {
    memberId: cy.id,
    role: "freelancer",
    organizationId: org.id,
  });
  expect(changed.status).toBe(200);
  expect(await closed).toBe(4403);
  await anaSocket.until(
    (e) => e.type === "talk.online" && e.memberId === cy.id && e.online === false,
  );
  const again = await connect(cy.cookie);
  const online = (await api(ana.cookie, "GET", "/people")).body.people.map(
    (p: { memberId: string }) => p.memberId,
  );
  expect(online).not.toContain(cy.id);
  expect(anaSocket.talk().filter((e) => e.memberId === cy.id && e.online === true)).toHaveLength(1);
  again.socket.close();
  anaSocket.socket.close();
});
