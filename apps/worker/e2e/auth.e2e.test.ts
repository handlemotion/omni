import { createOrgWithOwner, schema } from "@omni/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authPost,
  CookieJar,
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  startMailServiceEndpoint,
  signIn,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
  workerEvents,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
type Worker = Awaited<ReturnType<typeof startWorker>>;
let worker: Worker;
/** The same database behind a private install's Worker (`SIGN_UP=invitation`, ADR 0018). */
let invitationOnly: Worker;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { WEB_APP_URL: WEB_ORIGIN },
  });
  invitationOnly = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { WEB_APP_URL: WEB_ORIGIN, SIGN_UP: "invitation" },
  });
});

afterAll(async () => {
  await worker?.server.close();
  await invitationOnly?.server.close();
  await mailService?.close();
  await database?.teardown();
});

test("a magic link from the outbox signs the member in, and the outbox ping verifies", async () => {
  const { db } = database;
  const org = await createOrg(db, "acme");
  const system = await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const member = await createMember(db, org.id, "ana@acme.test");

  const anonymous = await fetch(new URL("/api/me", worker.url));
  expect(anonymous.status).toBe(401);

  const requested = await fetch(new URL("/api/auth/sign-in/magic-link", worker.url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email: "ana@acme.test", callbackURL: "/" }),
  });
  expect(requested.status).toBe(200);

  // The link goes out as an ordinary send from the system mailbox.
  const actions = await db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.mailboxId, system.id));
  expect(actions).toHaveLength(1);
  const [action] = actions;
  expect(action!.kind).toBe("send");
  expect(action!.memberId).toBeNull();
  const payload = action!.payload as { from: string; to: string[]; text: string };
  expect(payload.from).toBe(SYSTEM_MAIL_FROM);
  expect(payload.to).toEqual(["ana@acme.test"]);

  // The mail service was told, with a signature its verifier accepts.
  const [ping] = await mailService.waitFor(1);
  expect(ping!.method).toBe("POST");
  expect(ping!.path).toBe("/ping");
  expect(ping!.verified.ok).toBe(true);

  const link = new URL(payload.text.match(/https?:\/\/\S+/)![0]);
  const verified = await fetch(new URL(link.pathname + link.search, worker.url), {
    redirect: "manual",
  });
  expect(verified.status).toBe(302);
  const cookie = verified.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookie).toContain("session_token");

  const me = await fetch(new URL("/api/me", worker.url), { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ id: member.id, orgId: org.id });

  // A link works once.
  const reused = await fetch(new URL(link.pathname + link.search, worker.url), {
    redirect: "manual",
  });
  expect(reused.headers.getSetCookie().filter((c) => /session_token=[^;]/.test(c))).toEqual([]);
});

async function me(jar: CookieJar, on: Worker = worker) {
  const response = await fetch(new URL("/api/me", on.url), { headers: { cookie: jar.header } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Outbox sends addressed to `email`, oldest first. */
async function mailTo(email: string) {
  const rows = await database.db
    .select({ payload: schema.mailActions.payload })
    .from(schema.mailActions)
    .where(
      and(
        eq(schema.mailActions.kind, "send"),
        sql`${schema.mailActions.payload}->'to' = ${JSON.stringify([email])}::jsonb`,
      ),
    )
    .orderBy(schema.mailActions.createdAt);
  return rows.map((r) => r.payload as { from: string; subject: string; text: string });
}

/** An org made the way an operator makes one (`org:create`), its owner signed in. */
async function signedInOwner(slug: string) {
  const { db } = database;
  if (!(await db.select().from(schema.mailboxes)).some((m) => m.address === SYSTEM_MAIL_FROM)) {
    await createMailbox(db, (await createOrg(db, "system")).id, SYSTEM_MAIL_FROM);
  }
  const owner = await createOrgWithOwner(db, {
    name: slug,
    slug,
    ownerEmail: `owner@${slug}.test`,
  });
  const jar = new CookieJar();
  await signIn(worker, db, `owner@${slug}.test`, jar);
  return { ...owner, jar };
}

/** Invites into the owner's active org, with no `organizationId`, as the web app does. */
async function invite(owner: { jar: CookieJar }, email: string, on: Worker = worker) {
  const response = await authPost(on, owner.jar, "/organization/invite-member", {
    email,
    role: "member",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

test("a brand-new email with no invitation signs up by magic link and has no workspace yet", async () => {
  await signedInOwner("open");
  const requested = await fetch(new URL("/api/auth/sign-in/magic-link", worker.url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email: "newcomer@open.test", callbackURL: "/" }),
  });
  expect(requested.status).toBe(200);
  const [mail] = await mailTo("newcomer@open.test");
  expect(mail!.from).toBe(SYSTEM_MAIL_FROM);
  const link = new URL(mail!.text.match(/https?:\/\/\S+magic-link\S+/)![0]);

  const jar = new CookieJar();
  const opened = await fetch(new URL(link.pathname + link.search, worker.url), {
    redirect: "manual",
  });
  jar.store(opened);
  expect(opened.status).toBe(302);
  expect(opened.headers.get("location")).not.toContain("error=");
  expect(jar.header).toContain("session_token");

  // One user, proven by the link, in no workspace: the app sends them to create one.
  const users = await database.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, "newcomer@open.test"));
  expect(users).toEqual([expect.objectContaining({ emailVerified: true })]);
  expect(
    await database.db.select().from(schema.members).where(eq(schema.members.userId, users[0]!.id)),
  ).toEqual([]);
  expect((await me(jar)).status).toBe(403);
  const onboarding = await fetch(new URL("/api/onboarding", worker.url), {
    headers: { cookie: jar.header },
  });
  expect(await onboarding.json()).toMatchObject({
    canCreateOrganization: true,
    organization: null,
  });

  // A second link to the same address signs in the same user, not a second one.
  await signIn(worker, database.db, "newcomer@open.test", jar);
  expect(
    await database.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "newcomer@open.test")),
  ).toEqual([{ id: users[0]!.id }]);
});

test("with SIGN_UP=invitation, an email with no account and no invitation is answered alike but mailed nothing", async () => {
  await signedInOwner("gate");
  const requested = await fetch(new URL("/api/auth/sign-in/magic-link", invitationOnly.url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email: "stranger@elsewhere.test", callbackURL: "/" }),
  });
  expect(requested.status).toBe(200);
  expect(await requested.json()).toEqual({ status: true });
  expect(await mailTo("stranger@elsewhere.test")).toEqual([]);
});

test("invite, then a brand-new user signs in by magic link, accepts, and is a member", async () => {
  const owner = await signedInOwner("invite");
  const invitationId = await invite(owner, "New@Invite.test");

  // The invitation goes out through the outbox, linking to the web app's accept page.
  const [mail] = await mailTo("new@invite.test");
  expect(mail!.from).toBe(SYSTEM_MAIL_FROM);
  expect(mail!.text).toContain(`${WEB_ORIGIN}/invite/${invitationId}`);

  const jar = new CookieJar();
  await signIn(worker, database.db, "new@invite.test", jar);
  expect((await me(jar)).status).toBe(403);

  const accepted = await authPost(worker, jar, "/organization/accept-invitation", { invitationId });
  expect(accepted.status).toBe(200);
  expect(await me(jar)).toMatchObject({
    status: 200,
    body: { orgId: owner.orgId, role: "member" },
  });

  // Sign-in links are bearer credentials: only ENVIRONMENT=development prints them.
  expect(workerEvents(worker).filter((e) => e.event === "auth.dev_link")).toEqual([]);
});

test("with SIGN_UP=invitation, a link sent while invited cannot sign up once the invitation is canceled", async () => {
  const owner = await signedInOwner("cancel");
  const invitationId = await invite(owner, "late@cancel.test", invitationOnly);
  await fetch(new URL("/api/auth/sign-in/magic-link", invitationOnly.url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email: "late@cancel.test", callbackURL: "/" }),
  });
  const link = (await mailTo("late@cancel.test"))
    .map((m) => m.text.match(/https?:\/\/\S+magic-link\S+/)?.[0])
    .find(Boolean);
  expect(link).toBeDefined();

  const canceled = await authPost(invitationOnly, owner.jar, "/organization/cancel-invitation", {
    invitationId,
  });
  expect(canceled.status).toBe(200);

  const url = new URL(link!);
  const opened = await fetch(new URL(url.pathname + url.search, invitationOnly.url), {
    redirect: "manual",
  });
  expect(opened.headers.get("location")).toContain("error=SIGN_UP_REQUIRES_INVITATION");
  expect(opened.headers.getSetCookie().filter((c) => /session_token=[^;]/.test(c))).toEqual([]);
  const users = await database.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, "late@cancel.test"));
  expect(users).toEqual([]);
});

test("with SIGN_UP=invitation, a signed-in user with no workspace cannot create one", async () => {
  // Invited, signed up, then removed from the only workspace they had.
  const owner = await signedInOwner("private");
  const invitationId = await invite(owner, "former@private.test", invitationOnly);
  const jar = new CookieJar();
  await signIn(invitationOnly, database.db, "former@private.test", jar);
  const accepted = await authPost(invitationOnly, jar, "/organization/accept-invitation", {
    invitationId,
  });
  expect(accepted.status).toBe(200);
  const removed = await authPost(invitationOnly, owner.jar, "/organization/remove-member", {
    memberIdOrEmail: "former@private.test",
  });
  expect(removed.status).toBe(200);

  const status = await fetch(new URL("/api/onboarding", invitationOnly.url), {
    headers: { cookie: jar.header },
  });
  expect(await status.json()).toMatchObject({ canCreateOrganization: false, organization: null });
  const created = await authPost(invitationOnly, jar, "/organization/create", {
    name: "Mine",
    slug: "mine-private",
  });
  expect(created.status).toBe(403);
});

test("a member of two orgs switches the active org, and /api/me follows it", async () => {
  const { db } = database;
  const first = await signedInOwner("first");
  const second = await createOrgWithOwner(db, {
    name: "second",
    slug: "second",
    ownerEmail: "owner@first.test",
  });

  expect((await me(first.jar)).body.orgId).toBe(first.orgId);
  const switched = await authPost(worker, first.jar, "/organization/set-active", {
    organizationId: second.orgId,
  });
  expect(switched.status).toBe(200);
  expect((await me(first.jar)).body).toMatchObject({ orgId: second.orgId, id: second.memberId });

  await authPost(worker, first.jar, "/organization/set-active", { organizationId: first.orgId });
  expect((await me(first.jar)).body.orgId).toBe(first.orgId);
});

test("two accounts in one browser: both listed, switchable, and one revocable", async () => {
  const one = await signedInOwner("one");
  const two = await createOrgWithOwner(database.db, {
    name: "two",
    slug: "two",
    ownerEmail: "owner@two.test",
  });
  // Same browser: the second sign-in keeps the first session alongside it.
  const jar = one.jar;
  await signIn(worker, database.db, "owner@two.test", jar);
  expect((await me(jar)).body.id).toBe(two.memberId);

  const listed = await fetch(new URL("/api/auth/multi-session/list-device-sessions", worker.url), {
    headers: { cookie: jar.header },
  });
  const sessions = (await listed.json()) as {
    session: { token: string };
    user: { email: string };
  }[];
  const tokenOf = (email: string) => sessions.find((s) => s.user.email === email)!.session.token;
  expect(sessions.map((s) => s.user.email).toSorted()).toEqual([
    "owner@one.test",
    "owner@two.test",
  ]);

  const switched = await authPost(worker, jar, "/multi-session/set-active", {
    sessionToken: tokenOf("owner@one.test"),
  });
  expect(switched.status).toBe(200);
  expect((await me(jar)).body.id).toBe(one.memberId);

  const revoked = await authPost(worker, jar, "/multi-session/revoke", {
    sessionToken: tokenOf("owner@two.test"),
  });
  expect(revoked.status).toBe(200);
  const after = await fetch(new URL("/api/auth/multi-session/list-device-sessions", worker.url), {
    headers: { cookie: jar.header },
  });
  expect(((await after.json()) as { user: { email: string } }[]).map((s) => s.user.email)).toEqual([
    "owner@one.test",
  ]);
  expect((await me(jar)).body.id).toBe(one.memberId);
});
