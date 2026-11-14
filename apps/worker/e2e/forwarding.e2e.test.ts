// CRM forwarding settings (ADR 0032) over the real Worker and Postgres: who can see and change a
// mailbox's forwarding address.
import { schema } from "@omni/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
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

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: { cookie, "content-type": "application/json" },
  });
}

async function mailboxOf(
  orgId: string,
  memberId: string,
  address: string,
  kind: "personal" | "shared",
  role: "owner" | "member",
) {
  const mailbox = await createMailbox(database.db, orgId, address, kind);
  await database.db
    .insert(schema.mailboxAccess)
    .values({ orgId, mailboxId: mailbox.id, memberId, role });
  return mailbox;
}

function put(cookie: string, mailboxId: string, body: unknown) {
  return api(`/mailboxes/${mailboxId}/forwarding`, cookie, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

test("an owner sets forwarding on each personal mailbox, in a personal space and a company alike; nobody else can", async () => {
  const { db } = database;
  // Ana: her personal space and her company, one personal mailbox in each.
  const space = await createOrg(db, "ana-space");
  const company = await createOrg(db, "chowmein");
  const ana = await createMember(db, space.id, "ana@space.test");
  const [anaAtWork] = await db
    .insert(schema.members)
    .values({
      id: randomUUID(),
      organizationId: company.id,
      userId: ana.userId,
      createdAt: new Date(),
    })
    .returning();
  const mine = await mailboxOf(space.id, ana.id, "ana@space.test", "personal", "owner");
  const work = await mailboxOf(company.id, anaAtWork!.id, "ana@chowmein.test", "personal", "owner");
  const hello = await mailboxOf(
    company.id,
    anaAtWork!.id,
    "hello@chowmein.test",
    "shared",
    "owner",
  );
  // A teammate who can open Ana's work mailbox, but does not own it.
  const bo = await createMember(db, company.id, "bo@chowmein.test");
  await db
    .insert(schema.mailboxAccess)
    .values({ orgId: company.id, mailboxId: work.id, memberId: bo.id });

  const anaCookie = await signIn(worker, db, "ana@space.test");
  const boCookie = await signIn(worker, db, "bo@chowmein.test");

  const listed = await (await api("/forwarding", anaCookie)).json();
  expect(listed.mailboxes.map((m: { address: string }) => m.address).sort()).toEqual([
    "ana@chowmein.test",
    "ana@space.test",
  ]);
  expect(
    listed.mailboxes.every((m: { forwardAddress: unknown }) => m.forwardAddress === null),
  ).toBe(true);

  expect((await put(anaCookie, mine.id, { address: "Chowmein@Attio.email" })).status).toBe(200);
  expect(
    (await put(anaCookie, work.id, { address: "chowmein@attio.email", scope: "all" })).status,
  ).toBe(200);
  const after = await (await api("/forwarding", anaCookie)).json();
  expect(after.mailboxes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        mailboxId: mine.id,
        forwardAddress: "chowmein@attio.email",
        scope: "conversations",
        lastError: null,
      }),
      expect.objectContaining({
        mailboxId: work.id,
        forwardAddress: "chowmein@attio.email",
        scope: "all",
      }),
    ]),
  );

  // Shared inboxes are not a member's own address: Attio would drop their copies.
  expect((await put(anaCookie, hello.id, { address: "chowmein@attio.email" })).status).toBe(404);
  // Forwarding a mailbox to itself would loop.
  expect((await put(anaCookie, work.id, { address: "ANA@chowmein.test" })).status).toBe(400);
  expect((await put(anaCookie, work.id, { address: "not an address" })).status).toBe(400);

  // Bo can read Ana's work mail, but her CRM copies are hers to set.
  expect((await (await api("/forwarding", boCookie)).json()).mailboxes).toEqual([]);
  expect((await put(boCookie, work.id, { address: "bo@attacker.test" })).status).toBe(404);
  expect(
    (await api(`/mailboxes/${work.id}/forwarding`, boCookie, { method: "DELETE" })).status,
  ).toBe(404);

  expect(
    (await api(`/mailboxes/${work.id}/forwarding`, anaCookie, { method: "DELETE" })).status,
  ).toBe(200);
  const off = await (await api("/forwarding", anaCookie)).json();
  expect(off.mailboxes.find((m: { mailboxId: string }) => m.mailboxId === work.id)).toMatchObject({
    forwardAddress: null,
  });
  expect(off.mailboxes.find((m: { mailboxId: string }) => m.mailboxId === mine.id)).toMatchObject({
    forwardAddress: "chowmein@attio.email",
  });
});
