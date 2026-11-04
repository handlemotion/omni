// One person, one identity (ADR 0014): Google and magic links to the same verified address land
// on one user; extra sign-in emails, verified by a link, sign into that same user and reach the
// same mailboxes; an invitation to one of them joins that user. Unverified addresses do neither.
//
// The Google step runs Better Auth's own OAuth sign-in (`handleOAuthUserInfo`, what the callback
// calls once Google answers) against this suite's database, with the profile Google's ID token
// carries. The code exchange with Google itself cannot run locally and is not covered.
import { createAuth } from "@omni/auth";
import { createOrgWithOwner, schema } from "@omni/db";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authPost,
  CookieJar,
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
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
  await createMailbox(database.db, (await createOrg(database.db, "system")).id, SYSTEM_MAIL_FROM);
  // The Worker's own auth options, over the same database, with Google configured.
  googleAuth = createAuth({
    db: database.db,
    secret: "e2e-auth-secret-e2e-auth-secret-e2e-auth",
    baseURL: "http://localhost:8787",
    trustedOrigins: [WEB_ORIGIN],
    google: { clientId: "e2e-client.apps.googleusercontent.com", clientSecret: "e2e" },
    sendMagicLink: () => Promise.reject(new Error("this suite mails through the Worker")),
    sendInvitation: () => Promise.reject(new Error("this suite mails through the Worker")),
  });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

/** Google returned this profile (`sub`, `email`, `email_verified`) to our callback. */
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

/** Outbox sends to `email`, oldest first. */
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
  return rows.map((r) => r.payload as { subject: string; text: string });
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

/** An `org:create` owner with a personal and a shared mailbox, signed in by magic link. */
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
  return { ...created, email: `${slug}@gmail.test`, jar };
}

/** Asks for `email` to be added and returns the token from the mailed link. */
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
  // Magic link first (proves the address), then Google with Google's verified flag: linked.
  const ana = await owner("ana");
  const viaGoogle = await googleSignIn({ sub: "google-ana", email: ana.email, verified: true });
  expect(viaGoogle.userId).toBe(ana.userId);
  expect(await googleAccounts("google-ana")).toEqual([{ userId: ana.userId }]);
  expect(await usersWithEmail(ana.email)).toHaveLength(1);

  // Google first (invited, so sign-up is allowed), then a magic link: the same user.
  const host = await owner("host");
  const invited = await authPost(worker, host.jar, "/organization/invite-member", {
    email: "bea@gmail.test",
    role: "member",
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
  // Google does not vouch for the address: no link to the existing user, no new user.
  const cy = await owner("cy");
  const unvouched = await googleSignIn({ sub: "google-cy", email: cy.email, verified: false });
  expect(unvouched.userId).toBeNull();
  expect(await googleAccounts("google-cy")).toEqual([]);

  // An `org:create` owner who has not opened a magic link yet: Google cannot claim that row.
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

  // An invited address Google does not vouch for cannot sign up.
  await authPost(worker, cy.jar, "/organization/invite-member", {
    email: "eve@gmail.test",
    role: "member",
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

  // Not verified yet: the address is a stranger to sign-in and to Google.
  const token = await requestAddress(fay.jar, "fay.work@outlook.test");
  expect(token).toBeTruthy();
  const pending = await api(new CookieJar(), "/api/auth/sign-in/magic-link", {
    method: "POST",
    body: { email: "fay.work@outlook.test", callbackURL: "/" },
  });
  expect(pending.status).toBe(200);
  expect(await mailTo("fay.work@outlook.test")).toHaveLength(1); // only the confirmation link
  expect(
    (await googleSignIn({ sub: "google-fay-work", email: "fay.work@outlook.test", verified: true }))
      .userId,
  ).toBeNull();

  // Another signed-in person cannot use Fay's link, and trying does not spend it.
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
  // Single-use.
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

  // A magic link to the second address: same member, same mailboxes in the switcher.
  const other = new CookieJar();
  await signIn(worker, database.db, "fay.work@outlook.test", other);
  expect((await me(other))?.id).toBe(fay.memberId);
  expect(await workspaceMailboxes(other)).toEqual(before);
  expect(await usersWithEmail("fay.work@outlook.test")).toEqual([]);

  // Google with the second address links to Fay too.
  const viaGoogle = await googleSignIn({
    sub: "google-fay-work",
    email: "fay.work@outlook.test",
    verified: true,
  });
  expect(viaGoogle.userId).toBe(fay.userId);
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

  // Nor can an address another user already added.
  await addAddress(ivy.jar, "ivy.side@proton.test");
  const toSide = (await mailTo("ivy.side@proton.test")).length;
  const side = await api(hal.jar, "/api/account/emails", {
    method: "POST",
    body: { email: "ivy.side@proton.test" },
  });
  expect(side.status).toBe(200);
  expect(await mailTo("ivy.side@proton.test")).toHaveLength(toSide);

  // One's own address is answered plainly.
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
  const invited = await authPost(worker, kai.jar, "/organization/invite-member", {
    email: "jo.personal@gmail.test",
    role: "member",
  });
  expect(invited.status).toBe(200);
  const { id: invitationId } = (await invited.json()) as { id: string };

  // Jo opens the invitation mail and signs in with the invited address.
  const jar = new CookieJar();
  await signIn(worker, database.db, "jo.personal@gmail.test", jar);
  const shown = await api(jar, `/api/auth/organization/get-invitation?id=${invitationId}`);
  expect(shown.status).toBe(200);
  const accepted = await authPost(worker, jar, "/organization/accept-invitation", {
    invitationId,
  });
  expect(accepted.status).toBe(200);

  const memberships = await database.db
    .select({ orgId: schema.members.organizationId })
    .from(schema.members)
    .where(eq(schema.members.userId, jo.userId));
  expect(memberships.map((m) => m.orgId).toSorted()).toEqual([jo.orgId, kai.orgId].toSorted());
  expect(await usersWithEmail("jo.personal@gmail.test")).toEqual([]);

  // Someone else cannot take an invitation addressed to Jo's second address.
  const again = await authPost(worker, kai.jar, "/organization/invite-member", {
    email: "jo.personal@gmail.test",
    role: "member",
  });
  // Jo is a member now, through that address.
  expect(again.status).toBe(400);
});

test("the primary can move to another verified address; the last verified address stays", async () => {
  const lea = await owner("lea");
  await addAddress(lea.jar, "lea@icloud.test");

  // The primary cannot be removed.
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

  // Both still sign in as Lea.
  for (const email of [lea.email, "lea@icloud.test"]) {
    const jar = new CookieJar();
    await signIn(worker, database.db, email, jar);
    expect((await me(jar))?.id).toBe(lea.memberId);
  }

  // The old one removed: it is a stranger again and gets no link.
  const removed = await api(lea.jar, `/api/account/emails/${encodeURIComponent(lea.email)}`, {
    method: "DELETE",
  });
  expect(removed.status).toBe(200);
  const sent = (await mailTo(lea.email)).length;
  await api(new CookieJar(), "/api/auth/sign-in/magic-link", {
    method: "POST",
    body: { email: lea.email, callbackURL: "/" },
  });
  expect(await mailTo(lea.email)).toHaveLength(sent);
});
