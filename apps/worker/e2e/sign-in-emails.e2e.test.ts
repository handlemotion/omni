import { createAuth } from "@omni/auth";
import { createOrgWithOwner, schema } from "@omni/db";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { and, eq, sql } from "drizzle-orm";
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
let googleAuth: ReturnType<typeof createAuth>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { WEB_APP_URL: WEB_ORIGIN },
  });
  googleAuth = createAuth({
    db: database.db,
    secret: "e2e-auth-secret-e2e-auth-secret-e2e-auth",
    baseURL: "http://localhost:8787",
    trustedOrigins: [WEB_ORIGIN],
    google: { clientId: "e2e-client.apps.googleusercontent.com", clientSecret: "e2e" },
    modules: [],
    sendMagicLink: () => Promise.reject(new Error("this suite mails through the Worker")),
    sendInvitation: () => Promise.reject(new Error("this suite mails through the Worker")),
  });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

async function googleSignIn(profile: { sub: string; email: string; verified: boolean }) {
  const context = await googleAuth.$context;
  const result = await handleOAuthUserInfo({ context } as never, {
    userInfo: {
      id: profile.sub,
      email: profile.email,
      emailVerified: profile.verified,
      name: profile.email,
    },
    account: { providerId: "google", accountId: profile.sub },
    callbackURL: "/inbox",
  }).catch((error: unknown) => ({ error, data: null }));
  return { userId: result.data?.user.id ?? null, error: result.error };
}

async function usersWithEmail(email: string) {
  return database.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, email));
}

async function googleAccounts(sub: string) {
  return database.db
    .select({ userId: schema.accounts.userId })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.providerId, "google"), eq(schema.accounts.accountId, sub)));
}

function mailTo(email: string) {
  return sentMail(worker, email);
}

function api(jar: CookieJar, path: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(new URL(path, worker.url), {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie: jar.header },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function me(jar: CookieJar) {
  const response = await api(jar, "/api/me");
  return response.status === 200
    ? ((await response.json()) as { id: string; userId: string })
    : null;
}

async function owner(slug: string) {
  const { db } = database;
  const created = await createOrgWithOwner(db, {
    name: slug,
    slug,
    ownerEmail: `${slug}@gmail.test`,
  });
  const mine = await createMailbox(db, created.orgId, `${slug}@${slug}.test`, "personal");
  const shared = await createMailbox(db, created.orgId, `hello@${slug}.test`);
  await grant(db, created.orgId, mine.id, created.memberId);
  await grant(db, created.orgId, shared.id, created.memberId);
  const jar = new CookieJar();
  await signIn(worker, db, `${slug}@gmail.test`, jar);
  return { ...created, email: `${slug}@gmail.test`, jar, sharedInboxIds: [shared.id] };
}

async function requestAddress(jar: CookieJar, email: string) {
  const response = await api(jar, "/api/account/emails", { method: "POST", body: { email } });
  expect(response.status).toBe(200);
  const link = (await mailTo(email)).at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) return null;
  const url = new URL(link);
  expect(url.origin + url.pathname).toBe(`${WEB_ORIGIN}/settings/emails/verify`);
  return url.searchParams.get("token");
}

async function addAddress(jar: CookieJar, email: string) {
  const token = await requestAddress(jar, email);
  const verified = await api(jar, "/api/account/emails/verify", {
    method: "POST",
    body: { token },
  });
  expect(verified.status).toBe(200);
}

async function workspaceMailboxes(jar: CookieJar) {
  const body = (await (await api(jar, "/api/workspaces")).json()) as {
    workspaces: { id: string; mailboxes: { address: string }[] }[];
  };
  return body.workspaces.map((w) => ({
    id: w.id,
    mailboxes: w.mailboxes.map((m) => m.address).toSorted(),
  }));
}

test("Google and a magic link to the same verified address are one user, whichever comes first", async () => {
  const ana = await owner("ana");
  const viaGoogle = await googleSignIn({ sub: "google-ana", email: ana.email, verified: true });
  expect(viaGoogle.userId).toBe(ana.userId);
  expect(await googleAccounts("google-ana")).toEqual([{ userId: ana.userId }]);
  expect(await usersWithEmail(ana.email)).toHaveLength(1);

  const host = await owner("host");
  const invited = await invite(worker, host.jar, {
    email: "bea@gmail.test",
    role: "member",
    sharedInboxIds: host.sharedInboxIds,
  });
  expect(invited.status).toBe(200);
  const first = await googleSignIn({ sub: "google-bea", email: "bea@gmail.test", verified: true });
  expect(first.userId).toBeTruthy();
  const jar = new CookieJar();
  await signIn(worker, database.db, "bea@gmail.test", jar);
  const session = (await (await api(jar, "/api/auth/get-session")).json()) as {
    user: { id: string };
  };
  expect(session.user.id).toBe(first.userId);
  expect(await usersWithEmail("bea@gmail.test")).toHaveLength(1);
});

test("an unverified address never links: not Google's, and not a local user who never proved it", async () => {
  const cy = await owner("cy");
  const unvouched = await googleSignIn({ sub: "google-cy", email: cy.email, verified: false });
  expect(unvouched.userId).toBeNull();
  expect(await googleAccounts("google-cy")).toEqual([]);

  const { db } = database;
  const fresh = await createOrgWithOwner(db, {
    name: "dee",
    slug: "dee",
    ownerEmail: "dee@gmail.test",
  });
  const claimed = await googleSignIn({
    sub: "google-dee",
    email: "dee@gmail.test",
    verified: true,
  });
  expect(claimed.userId).toBeNull();
  expect(await googleAccounts("google-dee")).toEqual([]);
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, fresh.userId));
  expect(row!.emailVerified).toBe(false);

  await invite(worker, cy.jar, {
    email: "eve@gmail.test",
    role: "member",
    sharedInboxIds: cy.sharedInboxIds,
  });
  const signUp = await googleSignIn({
    sub: "google-eve",
    email: "eve@gmail.test",
    verified: false,
  });
  expect(signUp.userId).toBeNull();
  expect(await usersWithEmail("eve@gmail.test")).toEqual([]);
});

test("a verified second address signs into the same user and the same mailboxes", async () => {
  const fay = await owner("fay");
  const before = await workspaceMailboxes(fay.jar);
  expect(before[0]!.mailboxes).toEqual(["fay@fay.test", "hello@fay.test"]);

  const token = await requestAddress(fay.jar, "fay.work@outlook.test");
  expect(token).toBeTruthy();

  const gil = await owner("gil");
  const stolen = await api(gil.jar, "/api/account/emails/verify", {
    method: "POST",
    body: { token },
  });
  expect(stolen.status).toBe(403);

  const verified = await api(fay.jar, "/api/account/emails/verify", {
    method: "POST",
    body: { token },
  });
  expect(verified.status).toBe(200);
  const again = await api(fay.jar, "/api/account/emails/verify", {
    method: "POST",
    body: { token },
  });
  expect(again.status).toBe(400);

  expect(await (await api(fay.jar, "/api/account/emails")).json()).toEqual({
    emails: [
      { email: "fay@gmail.test", primary: true, verified: true },
      { email: "fay.work@outlook.test", primary: false, verified: true },
    ],
  });

  const other = new CookieJar();
  await signIn(worker, database.db, "fay.work@outlook.test", other);
  expect((await me(other))?.id).toBe(fay.memberId);
  expect(await workspaceMailboxes(other)).toEqual(before);
  expect(await usersWithEmail("fay.work@outlook.test")).toEqual([]);

  const viaGoogle = await googleSignIn({
    sub: "google-fay-work",
    email: "fay.work@outlook.test",
    verified: true,
  });
  expect(viaGoogle.userId).toBe(fay.userId);
});

test("an address asked for but never confirmed is not the asker's: a sign-up with it is someone else", async () => {
  const kit = await owner("kit");
  const token = await requestAddress(kit.jar, "kit.work@outlook.test");

  const viaGoogle = await googleSignIn({
    sub: "google-kit-work",
    email: "kit.work@outlook.test",
    verified: true,
  });
  expect(viaGoogle.userId).not.toBeNull();
  expect(viaGoogle.userId).not.toBe(kit.userId);
  const jar = new CookieJar();
  await signIn(worker, database.db, "kit.work@outlook.test", jar);
  const session = (await (await api(jar, "/api/auth/get-session")).json()) as {
    user: { id: string };
  };
  expect(session.user.id).toBe(viaGoogle.userId);

  const verified = await api(kit.jar, "/api/account/emails/verify", {
    method: "POST",
    body: { token },
  });
  expect(verified.status).toBe(409);
  expect(await usersWithEmail("kit.work@outlook.test")).toEqual([{ id: viaGoogle.userId }]);
});

test("an address someone else signs in with cannot be claimed, and the answer does not say so", async () => {
  const hal = await owner("hal");
  const ivy = await owner("ivy");
  const sent = await mailTo(ivy.email);
  const response = await api(hal.jar, "/api/account/emails", {
    method: "POST",
    body: { email: ivy.email },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "sent", email: ivy.email });
  expect(await mailTo(ivy.email)).toHaveLength(sent.length);

  await addAddress(ivy.jar, "ivy.side@proton.test");
  const toSide = (await mailTo("ivy.side@proton.test")).length;
  const side = await api(hal.jar, "/api/account/emails", {
    method: "POST",
    body: { email: "ivy.side@proton.test" },
  });
  expect(side.status).toBe(200);
  expect(await mailTo("ivy.side@proton.test")).toHaveLength(toSide);

  const own = await api(hal.jar, "/api/account/emails", {
    method: "POST",
    body: { email: hal.email },
  });
  expect(own.status).toBe(409);
});

test("an invitation to a second address joins the existing user", async () => {
  const jo = await owner("jo");
  await addAddress(jo.jar, "jo.personal@gmail.test");

  const kai = await owner("kai");
  const invited = await invite(worker, kai.jar, {
    email: "jo.personal@gmail.test",
    role: "member",
    sharedInboxIds: kai.sharedInboxIds,
  });
  expect(invited.status).toBe(200);
  const {
    invitation: { id: invitationId },
  } = (await invited.json()) as { invitation: { id: string } };

  const jar = new CookieJar();
  await signIn(worker, database.db, "jo.personal@gmail.test", jar);
  const shown = await api(jar, `/api/auth/organization/get-invitation?id=${invitationId}`);
  expect(shown.status).toBe(200);
  const accepted = await authPost(worker, jar, "/organization/accept-invitation", {
    invitationId,
  });
  expect(accepted.status).toBe(200);

  const memberships = await database.db
    .select({ orgId: schema.members.organizationId, personalOf: schema.personalSpaces.userId })
    .from(schema.members)
    .leftJoin(schema.personalSpaces, eq(schema.personalSpaces.orgId, schema.members.organizationId))
    .where(eq(schema.members.userId, jo.userId));
  const companies = memberships.filter((m) => m.personalOf === null).map((m) => m.orgId);
  expect(companies.toSorted()).toEqual([jo.orgId, kai.orgId].toSorted());
  expect(memberships.filter((m) => m.personalOf !== null)).toEqual([]);
  expect(await usersWithEmail("jo.personal@gmail.test")).toEqual([]);

  const again = await invite(worker, kai.jar, {
    email: "jo.personal@gmail.test",
    role: "member",
    sharedInboxIds: kai.sharedInboxIds,
  });
  expect(again.status).toBe(400);
});

test("the primary can move to another verified address; the last verified address stays", async () => {
  const lea = await owner("lea");
  await addAddress(lea.jar, "lea@icloud.test");

  const primary = await api(lea.jar, `/api/account/emails/${encodeURIComponent(lea.email)}`, {
    method: "DELETE",
  });
  expect(primary.status).toBe(409);

  const moved = await api(lea.jar, "/api/account/emails/primary", {
    method: "POST",
    body: { email: "lea@icloud.test" },
  });
  expect(moved.status).toBe(200);
  expect(await (await api(lea.jar, "/api/account/emails")).json()).toEqual({
    emails: [
      { email: "lea@icloud.test", primary: true, verified: true },
      { email: lea.email, primary: false, verified: true },
    ],
  });

  for (const email of [lea.email, "lea@icloud.test"]) {
    const jar = new CookieJar();
    await signIn(worker, database.db, email, jar);
    expect((await me(jar))?.id).toBe(lea.memberId);
  }

  const removed = await api(lea.jar, `/api/account/emails/${encodeURIComponent(lea.email)}`, {
    method: "DELETE",
  });
  expect(removed.status).toBe(200);
  const jar = new CookieJar();
  await signIn(worker, database.db, lea.email, jar);
  expect((await me(jar))?.userId).not.toBe(lea.userId);
  const session = (await (await api(jar, "/api/auth/get-session")).json()) as {
    user: { id: string };
  };
  expect(session.user.id).not.toBe(lea.userId);
});
