// Shared-mailbox access through Better Auth teams (ADR 0008), over the real Worker and Postgres:
// team membership decides whose `/api/threads` shows a shared mailbox, personal mailboxes and
// per-person read state are untouched, and nothing crosses orgs.
import { randomUUID } from "node:crypto";
import { backfillMailboxTeams, saveMailbox, schema } from "@omni/db";
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
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

let keys = 0;

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": `mailbox-members-${keys++}`,
      ...init.headers,
    },
  });
}

async function threadIds(cookie: string) {
  const response = await api("/threads?view=all", cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { threads: { id: string }[] }).threads.map((t) => t.id);
}

async function mailboxIds(cookie: string) {
  const body = (await (await api("/mailboxes", cookie)).json()) as { mailboxes: { id: string }[] };
  return body.mailboxes.map((m) => m.id);
}

const put = (cookie: string, mailboxId: string, memberId: string) =>
  api(`/mailboxes/${mailboxId}/members/${memberId}`, cookie, { method: "PUT" });
const remove = (cookie: string, mailboxId: string, memberId: string) =>
  api(`/mailboxes/${mailboxId}/members/${memberId}`, cookie, { method: "DELETE" });

async function listed(cookie: string, mailboxId: string) {
  const response = await api(`/mailboxes/${mailboxId}/members`, cookie);
  if (response.status !== 200) return response.status;
  const body = (await response.json()) as { members: { memberId: string }[] };
  return body.members.map((m) => m.memberId).toSorted();
}

async function team(mailboxId: string) {
  const { db } = database;
  const [mailbox] = await db
    .select({ teamId: schema.mailboxes.teamId })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId));
  if (!mailbox?.teamId) return null;
  const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, mailbox.teamId));
  const users = await db
    .select({ userId: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .where(eq(schema.teamMembers.teamId, mailbox.teamId));
  return { ...row!, userIds: users.map((u) => u.userId).toSorted() };
}

async function grants(mailboxId: string) {
  const rows = await database.db
    .select({ memberId: schema.mailboxAccess.memberId })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  return rows.map((r) => r.memberId).toSorted();
}

/**
 * An org whose owner Ana has a personal mailbox and creates support@ the way the CLI and
 * onboarding do (`saveMailbox`), plus Bea, a plain member. One thread in each mailbox.
 */
async function workspace(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  const ana = await createMember(db, org.id, `ana@${slug}.test`);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, ana.id));
  const bea = await createMember(db, org.id, `bea@${slug}.test`);
  const save = (address: string, kind: "personal" | "shared") =>
    saveMailbox(db, {
      id: randomUUID(),
      orgId: org.id,
      address,
      kind,
      provider: "imap",
      credentialsEnc: "not-a-real-ciphertext",
      ownerMemberId: ana.id,
    });
  const personalId = await save(`ana@${slug}.test`, "personal");
  const supportId = await save(`support@${slug}.test`, "shared");
  const personal = { id: personalId, orgId: org.id };
  const support = { id: supportId, orgId: org.id };
  const personalThread = await seedMessage(db, personal, {
    subject: "Just for Ana",
    fromAddress: "friend@elsewhere.test",
    uid: 1,
  });
  const supportThread = await seedMessage(db, support, {
    subject: "Help please",
    fromAddress: "customer@elsewhere.test",
    uid: 1,
  });
  return {
    org,
    ana: { ...ana, cookie: await signIn(worker, db, `ana@${slug}.test`) },
    bea: { ...bea, cookie: await signIn(worker, db, `bea@${slug}.test`) },
    personal,
    support,
    personalThread: personalThread.threadId,
    supportThread: supportThread.threadId,
  };
}

test("creating a shared mailbox creates its team with the owner on it; a personal one gets none", async () => {
  const w = await workspace("create");
  const supportTeam = await team(w.support.id);
  expect(supportTeam).toMatchObject({
    name: "support@create.test",
    organizationId: w.org.id,
    memberCount: 1,
    userIds: [w.ana.userId],
  });
  expect(await team(w.personal.id)).toBeNull();
  expect(await listed(w.ana.cookie, w.support.id)).toEqual([w.ana.id]);
  expect(await listed(w.ana.cookie, w.personal.id)).toBe(404);
});

test("adding a member shows the shared mailbox in their threads, removing hides it; personal mail stays put", async () => {
  const w = await workspace("access");
  expect(await threadIds(w.bea.cookie)).toEqual([]);

  // Twice: the second add changes nothing.
  for (let i = 0; i < 2; i++)
    expect((await put(w.ana.cookie, w.support.id, w.bea.id)).status).toBe(200);
  expect(await threadIds(w.bea.cookie)).toEqual([w.supportThread]);
  expect(await mailboxIds(w.bea.cookie)).toEqual([w.support.id]);
  expect((await api(`/threads/${w.supportThread}`, w.bea.cookie)).status).toBe(200);
  expect(await team(w.support.id)).toMatchObject({
    memberCount: 2,
    userIds: [w.ana.userId, w.bea.userId].toSorted(),
  });
  expect(await grants(w.support.id)).toEqual([w.ana.id, w.bea.id].toSorted());
  expect(await listed(w.bea.cookie, w.support.id)).toEqual([w.ana.id, w.bea.id].toSorted());

  for (let i = 0; i < 2; i++)
    expect((await remove(w.ana.cookie, w.support.id, w.bea.id)).status).toBe(200);
  expect(await threadIds(w.bea.cookie)).toEqual([]);
  expect((await api(`/threads/${w.supportThread}`, w.bea.cookie)).status).toBe(404);
  expect(await listed(w.bea.cookie, w.support.id)).toBe(404);
  expect(await team(w.support.id)).toMatchObject({ memberCount: 1, userIds: [w.ana.userId] });

  // Ana's personal mailbox never showed up for Bea and is still Ana's alone.
  expect((await threadIds(w.ana.cookie)).toSorted()).toEqual(
    [w.personalThread, w.supportThread].toSorted(),
  );
  expect(await grants(w.personal.id)).toEqual([w.ana.id]);
  expect((await put(w.ana.cookie, w.personal.id, w.bea.id)).status).toBe(404);
  expect(await grants(w.personal.id)).toEqual([w.ana.id]);
});

test("read state on a shared mailbox stays per person", async () => {
  const w = await workspace("read");
  await put(w.ana.cookie, w.support.id, w.bea.id);
  const read = await api(`/threads/${w.supportThread}/state`, w.ana.cookie, {
    method: "PATCH",
    body: JSON.stringify({ read: true }),
  });
  expect(read.status).toBe(200);
  const unread = async (cookie: string) => {
    const body = (await (await api("/threads?view=all", cookie)).json()) as {
      threads: { id: string; unread: boolean }[];
    };
    return body.threads.find((t) => t.id === w.supportThread)?.unread;
  };
  expect(await unread(w.ana.cookie)).toBe(false);
  expect(await unread(w.bea.cookie)).toBe(true);
});

test("only owners and admins change the list, and nothing crosses orgs", async () => {
  const a = await workspace("orga");
  const b = await workspace("orgb");

  // A plain member can neither add nor remove, even themselves.
  expect((await put(a.bea.cookie, a.support.id, a.bea.id)).status).toBe(403);
  // Another org's owner cannot see, add to, or remove from org A's mailbox.
  expect(await listed(b.ana.cookie, a.support.id)).toBe(404);
  expect((await put(b.ana.cookie, a.support.id, b.bea.id)).status).toBe(404);
  expect((await remove(b.ana.cookie, a.support.id, a.ana.id)).status).toBe(404);
  // Org A's owner cannot add a member of org B.
  expect((await put(a.ana.cookie, a.support.id, b.bea.id)).status).toBe(404);

  expect(await grants(a.support.id)).toEqual([a.ana.id]);
  expect(await team(a.support.id)).toMatchObject({ userIds: [a.ana.userId] });
  expect(await threadIds(b.bea.cookie)).toEqual([]);
  expect(await threadIds(b.ana.cookie)).not.toContain(a.supportThread);
});

test("Better Auth's own team endpoints keep access in step and cannot delete a mailbox's team", async () => {
  const w = await workspace("hooks");
  const teamId = (await team(w.support.id))!.id;
  const jar = new CookieJar();
  await signIn(worker, database.db, "ana@hooks.test", jar);

  const added = await authPost(worker, jar, "/organization/add-team-member", {
    teamId,
    userId: w.bea.userId,
  });
  expect(added.status).toBe(200);
  expect(await threadIds(w.bea.cookie)).toEqual([w.supportThread]);
  // The same person through our endpoint is not a second team row.
  expect((await put(w.ana.cookie, w.support.id, w.bea.id)).status).toBe(200);
  expect(await team(w.support.id)).toMatchObject({
    memberCount: 2,
    userIds: [w.ana.userId, w.bea.userId].toSorted(),
  });

  const removed = await authPost(worker, jar, "/organization/remove-team-member", {
    teamId,
    userId: w.bea.userId,
  });
  expect(removed.status).toBe(200);
  expect(await threadIds(w.bea.cookie)).toEqual([]);

  const deleted = await authPost(worker, jar, "/organization/remove-team", { teamId });
  expect(deleted.status).toBe(400);
  expect(await team(w.support.id)).not.toBeNull();
});

test("backfill gives an existing shared mailbox a team from its grants, and a second run changes nothing", async () => {
  const { db } = database;
  const org = await createOrg(db, "legacy");
  const ana = await createMember(db, org.id, "ana@legacy.test");
  await db.update(schema.members).set({ role: "admin" }).where(eq(schema.members.id, ana.id));
  const bea = await createMember(db, org.id, "bea@legacy.test");
  const hello = await createMailbox(db, org.id, "hello@legacy.test", "shared");
  await grant(db, org.id, hello.id, ana.id);
  await grant(db, org.id, hello.id, bea.id);
  const thread = await seedMessage(db, hello, { subject: "Old", fromAddress: "x@y.test", uid: 1 });

  await backfillMailboxTeams(db);
  const first = await team(hello.id);
  expect(first).toMatchObject({
    name: "hello@legacy.test",
    organizationId: org.id,
    memberCount: 2,
    userIds: [ana.userId, bea.userId].toSorted(),
  });
  await backfillMailboxTeams(db);
  expect(await team(hello.id)).toEqual(first);
  expect(
    await db
      .select()
      .from(schema.teams)
      .where(and(eq(schema.teams.organizationId, org.id))),
  ).toHaveLength(1);
  expect(await grants(hello.id)).toEqual([ana.id, bea.id].toSorted());

  // From here the team decides.
  const anaCookie = await signIn(worker, db, "ana@legacy.test");
  const beaCookie = await signIn(worker, db, "bea@legacy.test");
  expect(await threadIds(beaCookie)).toEqual([thread.threadId]);
  expect((await remove(anaCookie, hello.id, bea.id)).status).toBe(200);
  expect(await threadIds(beaCookie)).toEqual([]);
});
