import { randomUUID } from "node:crypto";
import { createOrgWithOwner, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authPost,
  CookieJar,
  createMailbox,
  createTestDatabase,
  grant,
  invite,
  sentMail,
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
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { WEB_APP_URL: WEB_ORIGIN },
  });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function api(jar: CookieJar, path: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(new URL(path, worker.url), {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie: jar.header },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function json(jar: CookieJar, path: string) {
  const response = await api(jar, path);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function userId(email: string) {
  const [user] = await database.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  return user!.id;
}

async function personalSpaceOf(email: string) {
  return database.db
    .select({ orgId: schema.personalSpaces.orgId })
    .from(schema.personalSpaces)
    .where(eq(schema.personalSpaces.userId, await userId(email)));
}

async function company(slug: string) {
  const { db } = database;
  const created = await createOrgWithOwner(db, {
    name: `${slug} Co`,
    slug,
    ownerEmail: `${slug}@owner.test`,
  });
  const shared = await createMailbox(db, created.orgId, `hello@${slug}.test`);
  await grant(db, created.orgId, shared.id, created.memberId);
  const jar = new CookieJar();
  await signIn(worker, db, `${slug}@owner.test`, jar);
  return { ...created, jar, sharedId: shared.id };
}

async function invited(owner: { jar: CookieJar; sharedId: string }, email: string, role = "admin") {
  const response = await invite(worker, owner.jar, {
    email,
    role: role as "admin",
    sharedInboxIds: [owner.sharedId],
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { invitation: { id: string } }).invitation.id;
}

async function signedIn(email: string) {
  const jar = new CookieJar();
  await signIn(worker, database.db, email, jar);
  return jar;
}

test("an invited Gmail user who signs in without the link sees the invitation and joins", async () => {
  const acme = await company(`acme-${randomUUID().slice(0, 8)}`);
  const invitationId = await invited(acme, "friend@gmail.test");

  const jar = await signedIn("friend@gmail.test");
  expect(await personalSpaceOf("friend@gmail.test")).toEqual([]);
  expect((await json(jar, "/api/me?personal=on-demand")).status).toBe(403);

  const listed = await json(jar, "/api/invitations");
  expect(listed).toEqual({
    status: 200,
    body: {
      invitations: [
        {
          id: invitationId,
          email: "friend@gmail.test",
          role: "admin",
          expiresAt: expect.any(String),
          organization: { id: acme.orgId, name: expect.stringContaining("Co") },
          inviter: expect.objectContaining({ email: expect.stringContaining("@owner.test") }),
        },
      ],
    },
  });
  expect(await json(jar, `/api/invitations/${invitationId}`)).toMatchObject({
    status: 200,
    body: { status: "pending", invitation: { id: invitationId } },
  });

  const accepted = await authPost(worker, jar, "/organization/accept-invitation", { invitationId });
  expect(accepted.status).toBe(200);

  const me = await json(jar, "/api/me");
  expect(me.body).toMatchObject({ orgId: acme.orgId, role: "admin" });
  const access = await database.db
    .select({ mailboxId: schema.mailboxAccess.mailboxId })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.memberId, me.body.id as string));
  expect(access.map((a) => a.mailboxId)).toContain(acme.sharedId);

  expect((await json(jar, "/api/invitations")).body).toEqual({ invitations: [] });
  expect((await json(jar, `/api/invitations/${invitationId}`)).body).toMatchObject({
    status: "accepted",
  });
  expect(await personalSpaceOf("friend@gmail.test")).toEqual([]);
});

test("an existing member sees an invitation to another workspace, matched on any verified address in any case", async () => {
  const home = await company(`home-${randomUUID().slice(0, 8)}`);
  const other = await company(`other-${randomUUID().slice(0, 8)}`);
  const jar = home.jar;
  const second = `second-${randomUUID().slice(0, 8)}@gmail.test`;
  expect(
    (await api(jar, "/api/account/emails", { method: "POST", body: { email: second } })).status,
  ).toBe(200);
  const link = (await sentMail(worker, second)).at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
  const token = new URL(link!).searchParams.get("token");
  expect(
    (await api(jar, "/api/account/emails/verify", { method: "POST", body: { token } })).status,
  ).toBe(200);

  const invitationId = await invited(other, second, "member");
  await database.db
    .update(schema.invitations)
    .set({ email: second.toUpperCase() })
    .where(eq(schema.invitations.id, invitationId));

  const listed = await json(jar, "/api/invitations");
  expect(listed.body.invitations).toEqual([
    expect.objectContaining({ id: invitationId, email: second, role: "member" }),
  ]);
  const accepted = await authPost(worker, jar, "/organization/accept-invitation", { invitationId });
  expect(accepted.status).toBe(200);
  const memberships = await database.db
    .select({ orgId: schema.members.organizationId })
    .from(schema.members)
    .where(eq(schema.members.userId, home.userId));
  expect(memberships.map((m) => m.orgId).toSorted()).toEqual([home.orgId, other.orgId].toSorted());
});

test("nobody sees or accepts an invitation for an address they do not verifiably own", async () => {
  const acme = await company(`guard-${randomUUID().slice(0, 8)}`);
  const victim = `victim-${randomUUID().slice(0, 8)}@gmail.test`;
  const invitationId = await invited(acme, victim);

  const mallory = await signedIn(`mallory-${randomUUID().slice(0, 8)}@gmail.test`);
  const asked = await api(mallory, "/api/account/emails", {
    method: "POST",
    body: { email: victim },
  });
  expect(asked.status).toBe(200);

  expect((await json(mallory, "/api/invitations")).body).toEqual({ invitations: [] });
  expect(await json(mallory, `/api/invitations/${invitationId}`)).toEqual({
    status: 200,
    body: { status: "wrong_account" },
  });
  const accepted = await authPost(worker, mallory, "/organization/accept-invitation", {
    invitationId,
  });
  expect(accepted.status).toBe(403);
  const declined = await authPost(worker, mallory, "/organization/reject-invitation", {
    invitationId,
  });
  expect(declined.status).toBe(403);

  const [row] = await database.db
    .select({ status: schema.invitations.status })
    .from(schema.invitations)
    .where(eq(schema.invitations.id, invitationId));
  expect(row?.status).toBe("pending");
  const members = await database.db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.organizationId, acme.orgId));
  expect(members).toHaveLength(1);
});

test("expired and declined invitations leave the list and say so on their page", async () => {
  const acme = await company(`late-${randomUUID().slice(0, 8)}`);
  const email = `late-${randomUUID().slice(0, 8)}@gmail.test`;
  const expired = await invited(acme, email);
  await database.db
    .update(schema.invitations)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.invitations.id, expired));

  const jar = await signedIn(email);
  expect((await json(jar, "/api/invitations")).body).toEqual({ invitations: [] });
  expect((await json(jar, `/api/invitations/${expired}`)).body).toMatchObject({
    status: "expired",
    invitation: { organization: { id: acme.orgId } },
  });

  const other = await company(`nope-${randomUUID().slice(0, 8)}`);
  const declined = await invited(other, email);
  expect((await json(jar, "/api/invitations")).body.invitations).toHaveLength(1);
  const rejected = await authPost(worker, jar, "/organization/reject-invitation", {
    invitationId: declined,
  });
  expect(rejected.status).toBe(200);
  expect((await json(jar, "/api/invitations")).body).toEqual({ invitations: [] });
  expect((await json(jar, `/api/invitations/${declined}`)).body).toMatchObject({
    status: "declined",
  });
  expect((await json(jar, `/api/invitations/${randomUUID()}`)).status).toBe(404);
});

test("a brand-new user with no invitation gets no Personal space until they choose one", async () => {
  const email = `new-${randomUUID().slice(0, 8)}@gmail.test`;
  const jar = await signedIn(email);
  await signedIn(email);

  expect(await personalSpaceOf(email)).toEqual([]);
  expect((await json(jar, "/api/me?personal=on-demand")).status).toBe(403);
  expect(
    (await json(jar, "/api/workspaces?include=personal&personal=on-demand")).body,
  ).toMatchObject({ activeOrganizationId: null, workspaces: [] });
  expect((await json(jar, "/api/onboarding")).body).toMatchObject({
    canCreateOrganization: true,
    canCreatePersonalSpace: true,
    organization: null,
  });
  expect(await personalSpaceOf(email)).toEqual([]);

  const chosen = await api(jar, "/api/onboarding/personal", { method: "POST" });
  expect(chosen.status).toBe(200);
  const { organization } = (await chosen.json()) as { organization: { id: string; slug: string } };
  expect(await personalSpaceOf(email)).toEqual([{ orgId: organization.id }]);
  expect((await api(jar, "/api/onboarding/personal", { method: "POST" })).status).toBe(200);
  expect(await personalSpaceOf(email)).toHaveLength(1);

  expect((await json(jar, "/api/me")).body).toMatchObject({
    orgId: organization.id,
    role: "owner",
    setup: "complete",
  });
  expect((await json(jar, "/api/onboarding")).body).toMatchObject({
    canCreatePersonalSpace: false,
  });
});

test("Just me opens the Personal space at once, even for someone whose session was in a company", async () => {
  const acme = await company(`switch-${randomUUID().slice(0, 8)}`);
  expect((await json(acme.jar, "/api/me")).body).toMatchObject({ orgId: acme.orgId });
  const chosen = acme.jar.store(
    await api(acme.jar, "/api/onboarding/personal", { method: "POST" }),
  );
  expect(chosen.status).toBe(200);
  const { organization } = (await chosen.json()) as { organization: { id: string } };
  expect((await json(acme.jar, "/api/me?personal=on-demand")).body).toMatchObject({
    orgId: organization.id,
  });
});

test("a web app from before on-demand Personal spaces reads /me and finds the person in their Personal space", async () => {
  const email = `oldweb-${randomUUID().slice(0, 8)}@gmail.test`;
  const jar = await signedIn(email);
  const [me, listed] = await Promise.all([
    json(jar, "/api/me"),
    json(jar, "/api/workspaces?include=personal"),
  ]);
  const spaces = await personalSpaceOf(email);
  expect(spaces).toHaveLength(1);
  expect(me).toMatchObject({ status: 200, body: { orgId: spaces[0]!.orgId, role: "owner" } });
  expect(listed.body.workspaces).toEqual([
    expect.objectContaining({ id: spaces[0]!.orgId, kind: "personal" }),
  ]);
});

test("a client from before on-demand Personal spaces still gets one when it is in no workspace", async () => {
  const email = `ios-${randomUUID().slice(0, 8)}@gmail.test`;
  const jar = await signedIn(email);
  const listed = await json(jar, "/api/workspaces?include=personal");
  const [space] = await personalSpaceOf(email);
  expect(listed.body).toMatchObject({
    activeOrganizationId: space!.orgId,
    workspaces: [expect.objectContaining({ id: space!.orgId, kind: "personal" })],
  });

  const member = await company(`member-${randomUUID().slice(0, 8)}`);
  await json(member.jar, "/api/workspaces?include=personal");
  const owner = await database.db
    .select({ orgId: schema.personalSpaces.orgId })
    .from(schema.personalSpaces)
    .where(eq(schema.personalSpaces.userId, member.userId));
  expect(owner).toEqual([]);
});

test("an existing user's Personal space keeps working", async () => {
  const email = `before-${randomUUID().slice(0, 8)}@gmail.test`;
  const jar = await signedIn(email);
  await api(jar, "/api/onboarding/personal", { method: "POST" });
  const [space] = await personalSpaceOf(email);

  const again = await signedIn(email);
  expect((await json(again, "/api/me")).body).toMatchObject({ orgId: space!.orgId, role: "owner" });
  const [session] = await database.db
    .select({ active: schema.sessions.activeOrganizationId })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, await userId(email))))
    .orderBy(schema.sessions.createdAt);
  expect(session?.active).toBe(space!.orgId);
  expect(
    (await json(again, "/api/workspaces?include=personal&personal=on-demand")).body.workspaces,
  ).toEqual([expect.objectContaining({ id: space!.orgId, kind: "personal" })]);
  expect(await personalSpaceOf(email)).toHaveLength(1);
});
