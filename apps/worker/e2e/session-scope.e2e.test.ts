// A login opens only the workspace it belongs to (ADR 0024 decision 3), on the real Worker and
// Postgres. Ana belongs to Acme (which locks acme-scope.test), to Beta, and has a Personal space
// with mail; her primary address is at Acme and her extra sign-in address is personal. A magic
// link to the Acme address opens Acme only, everywhere the API reads across workspaces, and that
// session cannot widen itself: no other workspace, no new company, no invitation elsewhere, no new
// sign-in method. A magic link to her personal address opens everything.
//
// Google sign-ins note their address through the provider's `mapProfileToUser`, which only a real
// Google callback runs; that path is not exercised here.
import { randomUUID } from "node:crypto";
import { companyForAddress, ensurePersonalSpace, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authPost,
  CookieJar,
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
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

// Loose on purpose: each test reads the few fields it checks.
type Body = Record<string, unknown> & {
  threads: { orgId: string }[];
  counts: { orgId: string }[];
  workspaces: { id: string }[];
  scopedTo: string | null;
};

async function api(jar: CookieJar, path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: { cookie: jar.header, "content-type": "application/json", ...init.headers },
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as Body };
}

/** A company with one member (`userId`), one mailbox they can read and one thread in it. */
async function company(name: string, userId: string, domain?: string) {
  const { db } = database;
  const org = await createOrg(db, name);
  const [member] = await db
    .insert(schema.members)
    .values({
      id: randomUUID(),
      organizationId: org.id,
      userId,
      role: "owner",
      createdAt: new Date(),
    })
    .returning();
  if (domain)
    await db.insert(schema.mailDomains).values({ orgId: org.id, domain, provider: "imap" });
  const mailbox = await createMailbox(db, org.id, `hello@${domain ?? `${name}.test`}`);
  await grant(db, org.id, mailbox.id, member!.id);
  const { threadId } = await seedMessage(db, mailbox, {
    subject: `${name} news`,
    fromAddress: "client@example.test",
    uid: 1,
  });
  return { orgId: org.id, memberId: member!.id, threadId };
}

/** Ana: primary at Acme, an extra personal address, in Acme and Beta, Personal space with mail. */
async function ana() {
  const { db } = database;
  const tag = randomUUID().slice(0, 8);
  const domain = `acme-${tag}.test`;
  const work = `ana@${domain}`;
  const personal = `ana-${tag}@gmail.test`;
  const [user] = await db
    .insert(schema.users)
    .values({ id: randomUUID(), name: "Ana", email: work, emailVerified: true })
    .returning();
  await db
    .insert(schema.userEmails)
    .values({ userId: user!.id, email: personal, verifiedAt: new Date() });
  const acme = await company(`acme-${tag}`, user!.id, domain);
  const beta = await company(`beta-${tag}`, user!.id);
  const spaceId = await ensurePersonalSpace(db, user!.id);
  const [owner] = await db
    .select()
    .from(schema.members)
    .where(eq(schema.members.organizationId, spaceId));
  const box = await createMailbox(db, spaceId, personal, "personal");
  await grant(db, spaceId, box.id, owner!.id);
  const mine = await seedMessage(db, box, {
    subject: "Personal news",
    fromAddress: "mom@example.test",
    uid: 1,
  });
  return {
    userId: user!.id,
    domain,
    work,
    personal,
    acme,
    beta,
    spaceId,
    personalThread: mine.threadId,
  };
}

async function signedIn(email: string) {
  const jar = new CookieJar();
  await signIn(worker, database.db, email, jar);
  return jar;
}

async function threadOrgs(jar: CookieJar) {
  const { body } = await api(jar, "/threads?scope=all");
  return new Set((body.threads as { orgId: string }[]).map((t) => t.orgId));
}

test("a magic link to a company address opens that company only, everywhere", async () => {
  const a = await ana();
  const jar = await signedIn(a.work);

  expect((await api(jar, "/me")).body).toMatchObject({ orgId: a.acme.orgId });
  expect(await threadOrgs(jar)).toEqual(new Set([a.acme.orgId]));
  const counts = await api(jar, "/counts?scope=all");
  expect(new Set((counts.body.counts as { orgId: string }[]).map((c) => c.orgId))).toEqual(
    new Set([a.acme.orgId]),
  );
  const listed = await api(jar, "/workspaces?include=personal");
  expect(listed.body).toMatchObject({ scopedTo: a.acme.orgId });
  expect((listed.body.workspaces as { id: string }[]).map((w) => w.id)).toEqual([a.acme.orgId]);

  // Another workspace's thread, opened directly, is not there; Acme's is.
  expect((await api(jar, `/threads/${a.beta.threadId}`)).status).toBe(404);
  expect((await api(jar, `/threads/${a.personalThread}`)).status).toBe(404);
  expect((await api(jar, `/threads/${a.acme.threadId}`)).status).toBe(200);

  // It cannot switch to another workspace.
  const switched = await authPost(worker, jar, "/organization/set-active", {
    organizationId: a.beta.orgId,
  });
  expect(switched.status).toBe(403);
  expect(await switched.json()).toMatchObject({ code: "SESSION_SCOPED" });
  expect((await api(jar, "/me")).body).toMatchObject({ orgId: a.acme.orgId });
});

test("a magic link to a personal address opens every workspace", async () => {
  const a = await ana();
  const jar = await signedIn(a.personal);
  expect(await threadOrgs(jar)).toEqual(new Set([a.acme.orgId, a.beta.orgId, a.spaceId]));
  const listed = await api(jar, "/workspaces?include=personal");
  expect(listed.body.scopedTo).toBeNull();
  expect(new Set((listed.body.workspaces as { id: string }[]).map((w) => w.id))).toEqual(
    new Set([a.acme.orgId, a.beta.orgId, a.spaceId]),
  );
  const switched = await authPost(worker, jar, "/organization/set-active", {
    organizationId: a.beta.orgId,
  });
  expect(switched.status).toBe(200);
});

test("a scoped session cannot add a sign-in method, create a company or join another", async () => {
  const { db } = database;
  const a = await ana();
  const jar = await signedIn(a.work);

  const refusals = [
    await api(jar, "/account/emails", {
      method: "POST",
      body: JSON.stringify({ email: `admin-${randomUUID()}@gmail.test` }),
    }),
    await api(jar, "/auth/passkey/generate-register-options"),
  ];
  for (const refused of refusals) expect(refused.status).toBe(403);
  const created = await authPost(worker, jar, "/organization/create", {
    name: "Elsewhere",
    slug: `elsewhere-${randomUUID()}`,
  });
  expect(created.status).toBe(403);
  expect((await api(jar, "/onboarding")).body).toMatchObject({ canCreateOrganization: false });

  // An invitation to another company, addressed to the work address, cannot be accepted here.
  const other = await createOrg(db, "other");
  const [inviter] = await db
    .insert(schema.users)
    .values({ id: randomUUID(), name: "Gil", email: `gil-${randomUUID()}@other.test` })
    .returning();
  const invitationId = randomUUID();
  await db.insert(schema.invitations).values({
    id: invitationId,
    organizationId: other.id,
    email: a.work,
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
    inviterId: inviter!.id,
  });
  const accepted = await authPost(worker, jar, "/organization/accept-invitation", { invitationId });
  expect(accepted.status).toBe(403);

  expect(
    await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, a.userId)),
  ).toEqual([]);
  expect(
    await db.select().from(schema.members).where(eq(schema.members.organizationId, other.id)),
  ).toEqual([]);
  expect(
    (await db.select().from(schema.userEmails).where(eq(schema.userEmails.userId, a.userId))).map(
      (row) => row.email,
    ),
  ).toEqual([a.personal]);
});

test("a company address with no membership there opens nothing, and creates nothing", async () => {
  const a = await ana();
  const jar = await signedIn(`bob@${a.domain}`);
  expect((await api(jar, "/me")).status).toBe(403);
  expect((await api(jar, "/workspaces?include=personal")).body.workspaces).toEqual([]);
  expect((await api(jar, "/onboarding")).body).toMatchObject({
    organization: null,
    canCreateOrganization: false,
  });
});

test("a lock on a parent domain covers its subdomains; free mail is never a company's", async () => {
  const { db } = database;
  const a = await ana();
  expect(await companyForAddress(db, `ana@mail.${a.domain}`)).toBe(a.acme.orgId);
  expect(await companyForAddress(db, `ana@not${a.domain}`)).toBeNull();
  expect(await companyForAddress(db, a.personal)).toBeNull();
});

test("a scoped session cannot reach another company through Better Auth by id, slug or list", async () => {
  const { db } = database;
  const a = await ana();
  const jar = await signedIn(a.work);
  const [beta] = await db
    .select({ slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, a.beta.orgId));
  const auth = (path: string) =>
    fetch(new URL(`/api/auth${path}`, worker.url), {
      headers: { cookie: jar.header, origin: WEB_ORIGIN },
    });

  // Ana owns Beta, so without the scope each of these would work.
  const refused = [
    await authPost(worker, jar, "/organization/set-active", { organizationSlug: beta!.slug }),
    await authPost(worker, jar, "/organization/invite-member", {
      email: `intruder-${randomUUID()}@evil.test`,
      role: "admin",
      organizationId: a.beta.orgId,
    }),
    await authPost(worker, jar, "/organization/delete", { organizationId: a.beta.orgId }),
    await authPost(worker, jar, "/organization/delete", { organizationId: a.acme.orgId }),
    await auth(`/organization/get-full-organization?organizationId=${a.beta.orgId}`),
    await auth(`/organization/list-members?organizationId=${a.beta.orgId}`),
  ];
  for (const response of refused) expect(response.status).toBe(403);
  expect(
    await db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.organizationId, a.beta.orgId)),
  ).toEqual([]);
  expect((await api(jar, "/me")).body).toMatchObject({ orgId: a.acme.orgId });

  // Its own company still works, and the list of workspaces shows only it.
  expect((await auth(`/organization/list-members?organizationId=${a.acme.orgId}`)).status).toBe(
    200,
  );
  const listed = (await (await auth("/organization/list")).json()) as { id: string }[];
  expect(listed.map((org) => org.id)).toEqual([a.acme.orgId]);
});

test("deleting the company a session is scoped to ends that session", async () => {
  const a = await ana();
  const scoped = await signedIn(a.work);
  const full = await signedIn(a.personal);
  expect((await api(scoped, "/me")).status).toBe(200);
  const deleted = await authPost(worker, full, "/organization/delete", {
    organizationId: a.acme.orgId,
  });
  expect(deleted.status).toBe(200);
  // Not reopened as an unscoped session onto Beta and Personal.
  expect((await api(scoped, "/me")).status).toBe(401);
  expect((await api(scoped, "/threads?scope=all")).status).toBe(401);
  expect((await api(full, "/me")).status).toBe(200);
});
