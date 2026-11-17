import { ensurePersonalSpace, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authPost,
  CookieJar,
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

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });
}

async function get<T>(path: string, cookie: string) {
  const response = await api(path, cookie);
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

type Row = { id: string; orgId: string; subject: string; read: boolean };
type Counts = { counts: { orgId: string; mailboxId: string; inbox: number; unread: number }[] };
type Hits = { results: { threadId: string; orgId: string }[] };

async function activate(jar: CookieJar, orgId: string) {
  const switched = await authPost(worker, jar, "/organization/set-active", {
    organizationId: orgId,
  });
  if (switched.status !== 200) throw new Error(`set-active answered ${switched.status}`);
}

async function subjects(jar: CookieJar, query = "") {
  const lists = await Promise.all(
    [query, `${query}${query ? "&" : ""}scope=all`].map((q) =>
      get<{ threads: Row[] }>(`/threads${q ? `?${q}` : ""}`, jar.header),
    ),
  );
  expect(lists[1]!.threads).toEqual(lists[0]!.threads);
  return lists[0]!.threads.map((t) => t.subject);
}

async function searched(jar: CookieJar, q: string) {
  const runs = await Promise.all(
    ["", "&scope=all"].map((scope) =>
      get<Hits>(`/search?q=${encodeURIComponent(q)}${scope}`, jar.header),
    ),
  );
  expect(runs[1]!.results).toEqual(runs[0]!.results);
  return runs[0]!.results.map((r) => [r.orgId, r.threadId]).sort();
}

async function counted(jar: CookieJar) {
  const runs = await Promise.all(
    ["", "?scope=all"].map((scope) => get<Counts>(`/counts${scope}`, jar.header)),
  );
  expect(runs[1]!.counts).toEqual(runs[0]!.counts);
  return runs[0]!.counts.map((c) => [c.mailboxId, c.inbox, c.unread]).sort();
}

async function connect(cookie: string, org?: string) {
  const url = new URL(`/api/realtime${org ? `?org=${org}` : ""}`, worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: { type: string; mailboxId: string }[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    received.push(JSON.parse(String(e.data)));
    for (const waiter of waiters) waiter();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return {
    socket,
    received,
    async next(count: number) {
      const enough = Promise.withResolvers<void>();
      const check = () => received.length >= count && enough.resolve();
      waiters.add(check);
      check();
      await enough.promise.finally(() => waiters.delete(check));
      return received;
    },
  };
}

test("a person in two workspaces sees only the active one's mail under All, its counts and its search", async () => {
  const { db } = database;
  const acme = await createOrg(db, "acme");
  const globex = await createOrg(db, "globex");
  const initech = await createOrg(db, "initech");
  await createMailbox(db, acme.id, SYSTEM_MAIL_FROM);

  const umaAcme = await createMember(db, acme.id, "uma@acme.test");
  const umaGlobex = crypto.randomUUID();
  await db.insert(schema.members).values({
    id: umaGlobex,
    organizationId: globex.id,
    userId: umaAcme.userId,
    createdAt: new Date(),
  });
  const gus = await createMember(db, globex.id, "gus@globex.test");
  const ian = await createMember(db, initech.id, "ian@initech.test");

  const acmeBox = await createMailbox(db, acme.id, "uma@acme.test", "personal");
  const globexBox = await createMailbox(db, globex.id, "support@globex.test");
  const gusBox = await createMailbox(db, globex.id, "gus@globex.test", "personal");
  const initechBox = await createMailbox(db, initech.id, "hello@initech.test");
  await grant(db, acme.id, acmeBox.id, umaAcme.id);
  await grant(db, globex.id, globexBox.id, umaGlobex);
  await grant(db, globex.id, gusBox.id, gus.id);
  await grant(db, initech.id, initechBox.id, ian.id);

  const at = (day: number) => new Date(`2026-10-0${day}T09:00:00Z`);
  const seed = (box: { id: string; orgId: string }, subject: string, uid: number, day: number) =>
    seedMessage(db, box, { subject, fromAddress: "x@client.test", uid, sentAt: at(day) });
  const acmeOld = await seed(acmeBox, "Acme old", 1, 1);
  const globexMid = await seed(globexBox, "Globex mid", 1, 2);
  const acmeNew = await seed(acmeBox, "Acme new", 2, 3);
  const globexLate = await seed(globexBox, "Globex late", 2, 4);
  const gusNewest = await seed(gusBox, "Gus private", 1, 5);
  const initechNewest = await seed(initechBox, "Initech", 1, 6);

  const jar = new CookieJar();
  await signIn(worker, db, "uma@acme.test", jar);

  expect(await subjects(jar)).toEqual(["Acme new", "Acme old"]);
  const first = await get<{ threads: Row[]; nextCursor: string }>(
    "/threads?scope=all&limit=1",
    jar.header,
  );
  const rest = await get<{ threads: Row[]; nextCursor: string | null }>(
    `/threads?scope=all&limit=1&cursor=${first.nextCursor}`,
    jar.header,
  );
  expect([...first.threads, ...rest.threads].map((t) => [t.orgId, t.subject])).toEqual([
    [acme.id, "Acme new"],
    [acme.id, "Acme old"],
  ]);
  expect(await subjects(jar, "view=all")).toEqual(["Acme new", "Acme old"]);
  expect(await counted(jar)).toEqual([[acmeBox.id, 2, 2]]);
  expect(await searched(jar, "Acme")).toEqual(
    [
      [acme.id, acmeNew.threadId],
      [acme.id, acmeOld.threadId],
    ].sort(),
  );
  for (const q of ["Globex", "Gus private", "Initech"]) expect(await searched(jar, q)).toEqual([]);

  const thread = await get<{ id: string; orgId: string }>(
    `/threads/${globexMid.threadId}`,
    jar.header,
  );
  expect(thread.orgId).toBe(globex.id);
  const write = (path: string, method: string, body?: unknown) =>
    api(path, jar.header, {
      method,
      headers: { "idempotency-key": `key-${crypto.randomUUID()}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect(
    (await write(`/threads/${globexMid.threadId}/state`, "PATCH", { read: true })).status,
  ).toBe(200);
  expect(
    (
      await write(`/threads/${globexMid.threadId}/done`, "POST", {
        through: at(2).toISOString(),
      })
    ).status,
  ).toBe(200);
  const archived = await write(`/threads/${globexMid.threadId}/archive`, "POST");
  expect(archived.status).toBe(200);
  const { actionIds } = (await archived.json()) as { actionIds: string[] };
  expect(actionIds).toHaveLength(1);

  const created = await write(`/threads/${globexMid.threadId}/notes`, "POST", {
    body: "Call back",
  });
  expect(created.status).toBe(201);
  const { note } = (await created.json()) as { note: { id: string } };
  const notePath = `/threads/${globexMid.threadId}/notes/${note.id}`;
  expect((await write(notePath, "PATCH", { body: "Called" })).status).toBe(200);
  expect((await write(notePath, "DELETE")).status).toBe(204);

  const [state] = await db
    .select()
    .from(schema.threadState)
    .where(eq(schema.threadState.threadId, globexMid.threadId));
  expect(state).toMatchObject({ memberId: umaGlobex, orgId: globex.id, read: true });
  expect(state!.doneThrough).toEqual(at(2));
  const [action] = await db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.id, actionIds[0]!));
  expect(action).toMatchObject({ kind: "archive", memberId: umaGlobex, orgId: globex.id });
  expect(await get(`/actions/${actionIds[0]}`, jar.header)).toMatchObject({ id: actionIds[0] });

  await activate(jar, globex.id);
  expect(await subjects(jar)).toEqual(["Globex late"]);
  expect(await subjects(jar, "view=done")).toEqual(["Globex mid"]);
  expect(await subjects(jar, "view=all")).toEqual(["Globex late", "Globex mid"]);
  expect(await counted(jar)).toEqual([[globexBox.id, 1, 1]]);
  expect(await searched(jar, "Globex")).toEqual(
    [
      [globex.id, globexLate.threadId],
      [globex.id, globexMid.threadId],
    ].sort(),
  );
  for (const q of ["Acme", "Gus private", "Initech"]) expect(await searched(jar, q)).toEqual([]);

  for (const hidden of [gusNewest, initechNewest]) {
    expect((await api(`/threads/${hidden.threadId}`, jar.header)).status).toBe(404);
    expect((await write(`/threads/${hidden.threadId}/archive`, "POST")).status).toBe(404);
    expect((await write(`/threads/${hidden.threadId}/state`, "PATCH", { read: true })).status).toBe(
      404,
    );
  }
  expect(
    await db
      .select()
      .from(schema.threadState)
      .where(
        and(
          eq(schema.threadState.threadId, gusNewest.threadId),
          eq(schema.threadState.memberId, umaGlobex),
        ),
      ),
  ).toEqual([]);
  expect((await get<{ orgId: string }>(`/threads/${acmeOld.threadId}`, jar.header)).orgId).toBe(
    acme.id,
  );
});

test("the Personal space with no mailboxes shows none of the company's mail", async () => {
  const { db } = database;
  const acme = await createOrg(db, "acme-personal");
  await createMailbox(db, acme.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, acme.id, "ana@acme-personal.test");
  const spaceId = await ensurePersonalSpace(db, ana.userId);
  const box = await createMailbox(db, acme.id, "ana@acme-personal.test", "personal");
  await grant(db, acme.id, box.id, ana.id);

  const seed = (subject: string, uid: number, folder?: string) =>
    seedMessage(db, box, {
      subject,
      fromAddress: "client@example.test",
      uid,
      ...(folder ? { folder } : {}),
    });
  const asks = await seed("Acme asks", 1);
  const waits = await seed("Acme waits", 2);
  await seed("Acme sent", 1, "Sent");
  for (const [thread, triage] of [
    [asks, "needs_reply"],
    [waits, "waiting_on_them"],
  ] as const) {
    await db
      .update(schema.threads)
      .set({ triage, triageSource: "person" })
      .where(eq(schema.threads.id, thread.threadId));
  }

  const jar = new CookieJar();
  await signIn(worker, db, "ana@acme-personal.test", jar);
  const lists = [
    "view=inbox",
    "view=inbox&lane=needs_reply",
    "view=inbox&lane=waiting_on_them",
    "view=later",
    "view=done",
    "view=archive",
    "view=all",
    "view=sent",
    "view=trash",
    "view=spam",
  ];
  expect(await subjects(jar, "view=inbox&lane=needs_reply")).toEqual(["Acme asks"]);
  expect(await subjects(jar, "view=inbox&lane=waiting_on_them")).toEqual(["Acme waits"]);
  expect(await subjects(jar, "view=sent")).toEqual(["Acme sent"]);
  expect((await searched(jar, "Acme")).length).toBe(3);

  await activate(jar, spaceId);
  expect(await get<{ orgId: string }>("/me", jar.header)).toMatchObject({ orgId: spaceId });
  for (const list of lists) expect(await subjects(jar, list)).toEqual([]);
  expect(await counted(jar)).toEqual([]);
  for (const q of ["Acme", "asks", "waits", "sent"]) expect(await searched(jar, q)).toEqual([]);
  expect(await get<{ mailboxes: unknown[] }>("/mailboxes", jar.header)).toEqual({ mailboxes: [] });
});

test("a realtime socket opens for any of the user's workspaces, and only for their own", async () => {
  const { db } = database;
  const north = await createOrg(db, "north");
  const south = await createOrg(db, "south");
  const elsewhere = await createOrg(db, "elsewhere");
  await createMailbox(db, north.id, SYSTEM_MAIL_FROM);
  const noaNorth = await createMember(db, north.id, "noa@north.test");
  const noaSouth = crypto.randomUUID();
  await db.insert(schema.members).values({
    id: noaSouth,
    organizationId: south.id,
    userId: noaNorth.userId,
    createdAt: new Date(),
  });
  const southBox = await createMailbox(db, south.id, "desk@south.test");
  await grant(db, south.id, southBox.id, noaSouth);
  const thread = await seedMessage(db, southBox, {
    subject: "Southern news",
    fromAddress: "x@client.test",
    uid: 1,
  });

  const cookie = await signIn(worker, db, "noa@north.test");
  await expect(connect(cookie, elsewhere.id)).rejects.toThrow("websocket failed to open");

  const southSocket = await connect(cookie, south.id);
  expect(
    (
      await postMailEvents(worker, {
        events: [
          {
            type: "message.created",
            folderRole: "inbox",
            orgId: south.id,
            mailboxId: southBox.id,
            threadId: thread.threadId,
            messageId: thread.messageId,
          },
        ],
      })
    ).status,
  ).toBe(202);
  expect(await southSocket.next(2)).toEqual([
    { type: "changed", mailboxId: southBox.id, threadIds: [thread.threadId] },
    { type: "thread.changed", mailboxId: southBox.id, threadIds: [thread.threadId] },
  ]);
  southSocket.socket.close();
});

test("a request that names its workspace is answered for it, whichever one the session has active", async () => {
  const { db } = database;
  const north = await createOrg(db, "north");
  const south = await createOrg(db, "south");
  const elsewhere = await createOrg(db, "elsewhere");
  const zoeNorth = await createMember(db, north.id, "zoe@north.test");
  const zoeSouth = crypto.randomUUID();
  await db.insert(schema.members).values({
    id: zoeSouth,
    organizationId: south.id,
    userId: zoeNorth.userId,
    createdAt: new Date(),
  });
  await createMember(db, elsewhere.id, "eve@elsewhere.test");
  const northBox = await createMailbox(db, north.id, "zoe@north.test", "personal");
  const southBox = await createMailbox(db, south.id, "help@south.test");
  await grant(db, north.id, northBox.id, zoeNorth.id);
  await grant(db, south.id, southBox.id, zoeSouth);
  const sentAt = new Date("2026-10-01T09:00:00Z");
  await seedMessage(db, northBox, { subject: "North", fromAddress: "x@c.test", uid: 1, sentAt });
  await seedMessage(db, southBox, { subject: "South", fromAddress: "x@c.test", uid: 1, sentAt });

  const jar = new CookieJar();
  await signIn(worker, db, "zoe@north.test", jar);
  const tab = async (orgId: string, path: string) => {
    const response = await api(path, jar.header, { headers: { "omni-workspace": orgId } });
    return { response, answeredFor: response.headers.get("omni-workspace") };
  };
  const listed = async (orgId: string) => {
    const { response, answeredFor } = await tab(orgId, "/threads");
    expect(response.status).toBe(200);
    expect(answeredFor).toBe(orgId);
    return ((await response.json()) as { threads: Row[] }).threads.map((t) => t.subject);
  };

  for (const active of [north.id, south.id]) {
    await activate(jar, active);
    expect(await listed(north.id)).toEqual(["North"]);
    expect(await listed(south.id)).toEqual(["South"]);
    const me = await tab(south.id, "/me");
    expect(((await me.response.json()) as { orgId: string }).orgId).toBe(south.id);
  }
  const byUrl = await get<{ threads: Row[] }>(`/threads?workspace=${north.id}`, jar.header);
  expect(byUrl.threads.map((t) => t.subject)).toEqual(["North"]);
  expect(await subjects(jar)).toEqual(["South"]);

  const foreign = await tab(elsewhere.id, "/threads");
  expect(foreign.response.status).toBe(403);
  expect(foreign.answeredFor).toBeNull();
});
