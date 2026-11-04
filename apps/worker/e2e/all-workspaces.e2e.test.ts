// The cross-workspace view (ADR 0014): one user in two organizations lists, counts, opens and
// acts on threads from both without switching the active org, and never sees a mailbox none of
// their members was granted.
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
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

/** Opens the realtime socket as the web app does, optionally for one of the user's orgs. */
async function connect(cookie: string, org?: string) {
  const url = new URL(`/api/realtime${org ? `?org=${org}` : ""}`, worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: { type: string; mailboxId: string }[] = [];
  socket.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return { socket, received };
}

test("one user in two workspaces lists, counts, opens and acts on both, and nothing else", async () => {
  const { db } = database;
  const acme = await createOrg(db, "acme");
  const globex = await createOrg(db, "globex");
  const initech = await createOrg(db, "initech");
  await createMailbox(db, acme.id, SYSTEM_MAIL_FROM);

  // Uma: a member of Acme (her first, so the active org) and of Globex.
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
  await seed(acmeBox, "Acme new", 2, 3);
  const gusNewest = await seed(gusBox, "Gus private", 1, 5);
  const initechNewest = await seed(initechBox, "Initech", 1, 6);

  const cookie = await signIn(worker, db, "uma@acme.test");

  // The active workspace alone, as before.
  const active = await get<{ threads: Row[] }>("/threads", cookie);
  expect(active.threads.map((t) => t.subject)).toEqual(["Acme new", "Acme old"]);

  // Every workspace, newest first, paged by cursor. Gus's mailbox and Initech never show.
  const first = await get<{ threads: Row[]; nextCursor: string }>(
    "/threads?scope=all&limit=2",
    cookie,
  );
  const rest = await get<{ threads: Row[]; nextCursor: string | null }>(
    `/threads?scope=all&limit=2&cursor=${first.nextCursor}`,
    cookie,
  );
  expect([...first.threads, ...rest.threads].map((t) => [t.orgId, t.subject])).toEqual([
    [acme.id, "Acme new"],
    [globex.id, "Globex mid"],
    [acme.id, "Acme old"],
  ]);
  expect(rest.nextCursor).toBeNull();

  // Search: every workspace with scope=all, the active one by default; never Gus or Initech.
  type Hits = { results: { threadId: string; orgId: string }[] };
  const searched = async (q: string, scope = "all") =>
    (await get<Hits>(`/search?scope=${scope}&q=${encodeURIComponent(q)}`, cookie)).results.map(
      (r) => [r.orgId, r.threadId],
    );
  expect(await searched("Globex mid")).toEqual([[globex.id, globexMid.threadId]]);
  expect(await searched("Globex mid", "workspace")).toEqual([]);
  expect(await searched("Gus private")).toEqual([]);
  expect(await searched("Initech")).toEqual([]);

  const counts = await get<Counts>("/counts?scope=all", cookie);
  expect(counts.counts.map((c) => [c.mailboxId, c.inbox, c.unread]).sort()).toEqual(
    [
      [acmeBox.id, 2, 2],
      [globexBox.id, 1, 1],
    ].sort(),
  );

  // A Globex thread opens and takes actions while Acme stays active, as Uma's Globex member.
  const thread = await get<{ id: string; orgId: string }>(`/threads/${globexMid.threadId}`, cookie);
  expect(thread.orgId).toBe(globex.id);
  const write = (path: string, method: string, body?: unknown) =>
    api(path, cookie, {
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
  expect(await get(`/actions/${actionIds[0]}`, cookie)).toMatchObject({ id: actionIds[0] });

  // Done and archived: off the cross-workspace inbox, on its done view.
  const inbox = await get<{ threads: Row[] }>("/threads?scope=all", cookie);
  expect(inbox.threads.map((t) => t.subject)).toEqual(["Acme new", "Acme old"]);
  const done = await get<{ threads: Row[] }>("/threads?scope=all&view=done", cookie);
  expect(done.threads.map((t) => [t.subject, t.read])).toEqual([["Globex mid", true]]);

  // Mailboxes no member of Uma's was granted: not readable, not writable, by any route.
  for (const hidden of [gusNewest, initechNewest]) {
    expect((await api(`/threads/${hidden.threadId}`, cookie)).status).toBe(404);
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
  // The Acme thread is still read as Acme's member.
  expect((await get<{ orgId: string }>(`/threads/${acmeOld.threadId}`, cookie)).orgId).toBe(
    acme.id,
  );
});

test("the web app keeps a realtime socket per workspace, and only for the user's own", async () => {
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
  // An org she does not belong to is refused.
  await expect(connect(cookie, elsewhere.id)).rejects.toThrow("websocket failed to open");

  // North is active; the South socket still gets South's mail.
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
  const deadline = Date.now() + 10_000;
  while (southSocket.received.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(southSocket.received).toEqual([
    { type: "changed", mailboxId: southBox.id, threadIds: [thread.threadId] },
  ]);
  southSocket.socket.close();
});
