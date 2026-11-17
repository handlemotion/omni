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

type Body = Record<string, unknown> & {
  mailboxes: { id: string; orgId: string }[];
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

  expect((await api(jar, `/threads/${a.beta.threadId}`)).status).toBe(404);
  expect((await api(jar, `/threads/${a.personalThread}`)).status).toBe(404);
  expect((await api(jar, `/threads/${a.acme.threadId}`)).status).toBe(200);

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
  expect(await threadOrgs(jar)).toEqual(new Set([a.acme.orgId]));
  const listed = await api(jar, "/workspaces?include=personal");
  expect(listed.body.scopedTo).toBeNull();
  expect(new Set((listed.body.workspaces as { id: string }[]).map((w) => w.id))).toEqual(
    new Set([a.acme.orgId, a.beta.orgId, a.spaceId]),
  );
  const switched = await authPost(worker, jar, "/organization/set-active", {
    organizationId: a.beta.orgId,
  });
  expect(switched.status).toBe(200);
  expect(await threadOrgs(jar)).toEqual(new Set([a.beta.orgId]));
  expect(
    (await authPost(worker, jar, "/organization/set-active", { organizationId: a.spaceId })).status,
  ).toBe(200);
  expect(await threadOrgs(jar)).toEqual(new Set([a.spaceId]));
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

  const refused = [
    await authPost(worker, jar, "/organization/set-active", { organizationSlug: beta!.slug }),
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
  expect((await api(scoped, "/me")).status).toBe(401);
  expect((await api(scoped, "/threads?scope=all")).status).toBe(401);
  expect((await api(full, "/me")).status).toBe(200);
});

test("a full session lists and sends from every workspace's mailboxes; a scoped one only its company's", async () => {
  const { db } = database;
  const a = await ana();
  const send = (jar: CookieJar, mailboxId: string, key: string) =>
    api(jar, "/send", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({
        mailboxId,
        to: ["client@example.test"],
        subject: "Hi",
        text: "Hello",
      }),
    });
  const boxOf = async (orgId: string) =>
    (
      await db
        .select({ id: schema.mailboxes.id })
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.orgId, orgId))
    )[0]!.id;
  const acmeBox = await boxOf(a.acme.orgId);
  const betaBox = await boxOf(a.beta.orgId);

  const full = await signedIn(a.personal);
  const listed = await api(full, "/mailboxes?scope=all");
  expect(new Set((listed.body.mailboxes as { orgId: string }[]).map((m) => m.orgId))).toEqual(
    new Set([a.acme.orgId, a.beta.orgId, a.spaceId]),
  );
  expect((await api(full, "/me")).body).toMatchObject({ orgId: a.acme.orgId });
  const sent = await send(full, betaBox, `beta-${randomUUID()}`);
  expect(sent.status).toBe(202);
  const [action] = await db
    .select({ orgId: schema.mailActions.orgId, memberId: schema.mailActions.memberId })
    .from(schema.mailActions)
    .where(eq(schema.mailActions.mailboxId, betaBox));
  expect(action).toEqual({ orgId: a.beta.orgId, memberId: a.beta.memberId });

  const scoped = await signedIn(a.work);
  const scopedList = await api(scoped, "/mailboxes?scope=all");
  expect((scopedList.body.mailboxes as { id: string }[]).map((m) => m.id)).toEqual([acmeBox]);
  expect((await send(scoped, betaBox, `scoped-${randomUUID()}`)).status).toBe(404);
  expect(
    await db.select().from(schema.mailActions).where(eq(schema.mailActions.mailboxId, betaBox)),
  ).toHaveLength(1);
  expect((await send(scoped, acmeBox, `acme-${randomUUID()}`)).status).toBe(202);
});

test("a draft and a send in another workspace can be saved, sent and undone from the active one", async () => {
  const a = await ana();
  const [betaBox] = await database.db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.orgId, a.beta.orgId));
  const full = await signedIn(a.personal);
  expect((await api(full, "/me")).body).toMatchObject({ orgId: a.acme.orgId });

  const draft = async () => {
    const created = await api(full, "/drafts", {
      method: "POST",
      body: JSON.stringify({ mailboxId: betaBox!.id, kind: "new" }),
    });
    expect(created.status).toBe(201);
    return created.body as unknown as { id: string; version: number };
  };
  const first = await draft();
  const saved = await api(full, `/drafts/${first.id}`, {
    method: "PUT",
    body: JSON.stringify({
      version: first.version,
      to: [{ name: null, address: "client@example.test" }],
      subject: "Hi",
      bodyText: "Hello",
    }),
  });
  expect(saved.status).toBe(200);
  const sent = await api(full, `/drafts/${first.id}/send`, {
    method: "POST",
    headers: { "idempotency-key": `draft-${randomUUID()}` },
  });
  expect(sent.status).toBe(202);
  const actionId = (sent.body as unknown as { actionId: string }).actionId;
  const undone = await api(full, `/actions/${actionId}/cancel`, { method: "POST" });
  expect(undone).toMatchObject({ status: 200, body: { cancelled: true } });

  const second = await draft();
  const scoped = await signedIn(a.work);
  const refused = await api(scoped, `/drafts/${second.id}`, {
    method: "PUT",
    body: JSON.stringify({ version: second.version, subject: "taken over" }),
  });
  expect(refused.status).toBe(404);
});
