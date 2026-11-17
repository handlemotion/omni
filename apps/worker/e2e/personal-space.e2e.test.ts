import { randomUUID } from "node:crypto";
import {
  ensurePersonalSpace,
  PersonalSpaceError,
  saveMailbox,
  schema,
  transferDomain,
} from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authPost,
  CookieJar,
  createTestDatabase,
  invite,
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

async function get(jar: CookieJar, path: string) {
  const response = await fetch(new URL(`/api${path}`, worker.url), {
    headers: { cookie: jar.header },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function personalSpaces(userId: string) {
  return database.db
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.personalSpaces)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.personalSpaces.orgId))
    .where(eq(schema.personalSpaces.userId, userId));
}

async function userId(email: string) {
  const [user] = await database.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  return user!.id;
}

async function signedUp(email: string) {
  const jar = new CookieJar();
  await signIn(worker, database.db, email, jar);
  const id = await userId(email);
  const [space] = await personalSpaces(id);
  return { jar, userId: id, spaceId: space!.id };
}

test("sign-up makes one Personal space, complete and owned; signing in again makes no second", async () => {
  const { db } = database;
  const { userId: id, spaceId } = await signedUp("solo@personal.test");
  await signIn(worker, db, "solo@personal.test");
  await signIn(worker, db, "solo@personal.test");

  const spaces = await personalSpaces(id);
  expect(spaces).toHaveLength(1);
  expect(spaces[0]).toEqual({ id: spaceId, name: "Personal" });
  const owners = await db
    .select({ role: schema.members.role, userId: schema.members.userId })
    .from(schema.members)
    .where(eq(schema.members.organizationId, spaceId));
  expect(owners).toEqual([{ role: "owner", userId: id }]);
  const [setup] = await db
    .select({ step: schema.orgSetup.step })
    .from(schema.orgSetup)
    .where(eq(schema.orgSetup.orgId, spaceId));
  expect(setup?.step).toBe("complete");
});

test("racing calls make one Personal space", async () => {
  const { db } = database;
  const [user] = await db
    .insert(schema.users)
    .values({ id: randomUUID(), name: "race", email: "race@personal.test", emailVerified: true })
    .returning();
  const ids = await Promise.all(Array.from({ length: 8 }, () => ensurePersonalSpace(db, user!.id)));
  expect(new Set(ids).size).toBe(1);
  expect(await personalSpaces(user!.id)).toHaveLength(1);
  const memberships = await db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.organizationId, ids[0]!), eq(schema.members.userId, user!.id)));
  expect(memberships).toHaveLength(1);
});

test("a person from before Personal spaces gets theirs at their next sign-in", async () => {
  const { db } = database;
  const [user] = await db
    .insert(schema.users)
    .values({ id: randomUUID(), name: "old", email: "old@personal.test", emailVerified: true })
    .returning();
  expect(await personalSpaces(user!.id)).toHaveLength(0);
  await signIn(worker, db, "old@personal.test");
  expect(await personalSpaces(user!.id)).toHaveLength(1);
});

test("with no company the Personal space is the default; setup still creates a company", async () => {
  const { jar, spaceId } = await signedUp("hidden@personal.test");
  expect((await get(jar, "/me")).body).toMatchObject({ orgId: spaceId, role: "owner" });
  expect((await get(jar, "/onboarding")).body).toMatchObject({
    canCreateOrganization: true,
    organization: null,
  });

  expect((await get(jar, "/workspaces")).body).toEqual({
    activeOrganizationId: spaceId,
    scopedTo: null,
    workspaces: [],
  });
  const all = await get(jar, "/workspaces?include=personal");
  expect(all.body.workspaces).toEqual([
    expect.objectContaining({ id: spaceId, kind: "personal", role: "owner", setup: "complete" }),
  ]);

  const created = await authPost(worker, jar, "/organization/create", {
    name: "Hidden Co",
    slug: `hidden-${randomUUID()}`,
  });
  expect(created.status).toBe(200);
  const companyId = ((await created.json()) as { id: string }).id;
  expect((await get(jar, "/me")).body).toMatchObject({ orgId: companyId, role: "owner" });
  expect((await get(jar, "/workspaces")).body.workspaces).toEqual([
    expect.objectContaining({ id: companyId, kind: "company" }),
  ]);
});

test("a Personal space refuses invitations, members, teams and being deleted", async () => {
  const { jar, spaceId } = await signedUp("owner@personal.test");
  await signedUp("friend@personal.test");
  const active = await authPost(worker, jar, "/organization/set-active", {
    organizationId: spaceId,
  });
  expect(active.status).toBe(200);

  expect((await invite(worker, jar, { email: "friend@personal.test" })).status).toBe(404);
  const refusals = [
    await authPost(worker, jar, "/organization/create-team", {
      name: "support",
      organizationId: spaceId,
    }),
    await authPost(worker, jar, "/organization/delete", { organizationId: spaceId }),
  ];
  for (const response of refusals) {
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PERSONAL_SPACE" });
  }

  const { db } = database;
  expect(
    await db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.organizationId, spaceId)),
  ).toEqual([]);
  expect(
    await db.select().from(schema.teams).where(eq(schema.teams.organizationId, spaceId)),
  ).toEqual([]);
  expect(
    await db.select().from(schema.members).where(eq(schema.members.organizationId, spaceId)),
  ).toHaveLength(1);
  expect(
    await db.select().from(schema.organizations).where(eq(schema.organizations.id, spaceId)),
  ).toHaveLength(1);
});

test("a Personal space holds no shared mailbox, but takes a personal one", async () => {
  const { db } = database;
  const { spaceId } = await signedUp("mail@personal.test");
  const [member] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.organizationId, spaceId));

  const mailbox = (kind: "personal" | "shared", address: string) =>
    saveMailbox(db, {
      id: randomUUID(),
      orgId: spaceId,
      address,
      kind,
      provider: "gmail",
      credentialsEnc: "not-a-real-ciphertext",
      ownerMemberId: member!.id,
    });
  await expect(mailbox("shared", "team@personal.test")).rejects.toBeInstanceOf(PersonalSpaceError);
  await expect(mailbox("personal", "me@gmail.test")).resolves.toEqual(expect.any(String));
  const rows = await db
    .select({ address: schema.mailboxes.address, kind: schema.mailboxes.kind })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.orgId, spaceId));
  expect(rows).toEqual([{ address: "me@gmail.test", kind: "personal" }]);
});

test("a company cannot hand its domain to a Personal space", async () => {
  const { db } = database;
  const { jar, spaceId } = await signedUp("mover@personal.test");
  const created = await authPost(worker, jar, "/organization/create", {
    name: "Mover Co",
    slug: `mover-${randomUUID()}`,
  });
  const companyId = ((await created.json()) as { id: string }).id;
  await db
    .insert(schema.mailDomains)
    .values({ orgId: companyId, domain: "mover-co.test", provider: "imap" });

  expect(
    await transferDomain(db, { fromOrgId: companyId, toOrgId: spaceId, domain: "mover-co.test" }),
  ).toEqual({ ok: false, reason: "personal_space" });
  const [lock] = await db
    .select({ orgId: schema.mailDomains.orgId })
    .from(schema.mailDomains)
    .where(eq(schema.mailDomains.domain, "mover-co.test"));
  expect(lock?.orgId).toBe(companyId);
});

test("a company whose handle looks like a Personal space's does not block anyone's sign-in", async () => {
  const { db } = database;
  const [user] = await db
    .insert(schema.users)
    .values({ id: randomUUID(), name: "clash", email: "clash@personal.test", emailVerified: true })
    .returning();
  await db.insert(schema.organizations).values({
    id: randomUUID(),
    name: "Squatter",
    slug: `personal-${user!.id}`,
    createdAt: new Date(),
  });
  const jar = new CookieJar();
  await signIn(worker, db, "clash@personal.test", jar);
  expect(jar.header).toContain("session_token");
  expect(await personalSpaces(user!.id)).toHaveLength(1);
});
