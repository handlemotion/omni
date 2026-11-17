// Mail activity sharing over the real Worker (ADR 0039 decision 2): the mailbox setting under
// `/api/mail`, and what it adds to a CRM record (`activity` timeline items, `lastContactedAt`).
// Who may set a level and what the door returns at each one are proven in `@omni/db`'s
// `mail-crm-sharing` suite; these catch the Worker getting it wrong around the door.
import { schema } from "@omni/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack, type Person } from "./crm-support.ts";
import { createMailbox, seedMessage } from "./support.ts";

let stack: CrmStack;

beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

/** A JSON call to `/api/mail` as `who`'s browser. */
async function mailApi(who: Person, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/mail${path}`, stack.worker.url), {
    method,
    headers: { cookie: who.jar.header, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

/** Ana's personal mailbox in `orgId`, with her owner grant as provisioning leaves it. */
async function personalMailbox(orgId: string, ana: Person, address: string) {
  const box = await createMailbox(stack.db, orgId, address, "personal");
  await stack.db
    .insert(schema.mailboxAccess)
    .values({ orgId, mailboxId: box.id, memberId: ana.id, role: "owner" });
  return box;
}

// Catches: the setting routes reaching past Mail's door (an admin turning on a teammate's
// personal mailbox, a mailbox of another workspace), a level the enum does not know stored, and
// a refusal answered as anything but the shared error shape.
test("the setting: its owner reads and sets it; an admin is refused on a teammate's personal mailbox", async () => {
  const acme = await stack.company("acme-setting");
  const ana = await stack.member(acme.id);
  const admin = await stack.member(acme.id, "admin");
  const box = await personalMailbox(acme.id, ana, "ana@acme-setting.test");
  const path = `/mailboxes/${box.id}/crm-sharing`;

  expect(await mailApi(ana, "GET", path)).toEqual({ status: 200, body: { level: "off" } });
  expect(await mailApi(ana, "PUT", path, { level: "activity" })).toEqual({
    status: 200,
    body: { level: "activity" },
  });
  expect((await mailApi(ana, "GET", path)).body).toEqual({ level: "activity" });

  const refused = await mailApi(admin, "PUT", path, { level: "subjects" });
  expect(refused.status).toBe(403);
  expect(refused.body).toMatchObject({ code: "FORBIDDEN" });
  expect((await mailApi(admin, "GET", path)).status).toBe(403);
  expect((await mailApi(ana, "PUT", path, { level: "everything" })).status).toBe(400);

  const beta = await stack.company("beta-setting");
  const owner = await stack.member(beta.id, "owner");
  expect((await mailApi(owner, "PUT", path, { level: "off" })).status).toBe(404);
  expect((await mailApi(ana, "GET", path)).body).toEqual({ level: "activity" });
});

// Catches: a teammate's timeline missing the activity, or carrying the thread (its id, url,
// snippet) or a subject the mailbox does not share; the owner's own thread shown twice; activity
// surviving the owner turning sharing off; and `lastContactedAt` ignoring shared activity.
test("a teammate sees shared activity on the timeline, never the thread, and lastContactedAt counts it", async () => {
  const acme = await stack.company("acme-activity");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);
  const box = await personalMailbox(acme.id, ana, "ana@acme-activity.test");
  const sentAt = new Date("2026-11-10T09:30:00.000Z");
  const { threadId } = await seedMessage(stack.db, box, {
    subject: "Secret pricing",
    fromAddress: "ana@acme-activity.test",
    to: ["carla@northwind.test"],
    uid: 1,
    sentAt,
    text: "The discount we never give anyone.",
  });
  const added = await stack.api(bea.jar, "POST", "/people", {
    name: "Carla",
    address: "carla@northwind.test",
  });
  const { id, companyId } = added.body.person;
  const deal = await stack.api(bea.jar, "POST", "/deals", {
    name: "Northwind renewal",
    companyId,
    personIds: [id],
  });
  expect(deal.status).toBe(201);
  const reads = [
    `/people/${id}`,
    `/companies/${companyId}`,
    `/deals/${deal.body.deal.id}`,
  ] as const;

  // Off: Bea sees nothing of it, and nobody contacted Carla as far as she can tell.
  const before = await stack.api(bea.jar, "GET", `/people/${id}/timeline`);
  expect(before.body.items.filter((item: { kind: string }) => item.kind !== "event")).toEqual([]);
  for (const path of reads) {
    expect((await stack.api(bea.jar, "GET", path)).body.lastContactedAt).toBeNull();
  }

  expect(
    (await mailApi(ana, "PUT", `/mailboxes/${box.id}/crm-sharing`, { level: "activity" })).status,
  ).toBe(200);
  const shared = await stack.api(bea.jar, "GET", `/companies/${companyId}/timeline`);
  const activity = shared.body.items.filter((item: { kind: string }) => item.kind === "activity");
  expect(activity).toEqual([
    {
      kind: "activity",
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      at: sentAt.toISOString(),
      activity: { mailbox: { kind: "personal", name: ana.email }, direction: "out", subject: null },
    },
  ]);
  const text = JSON.stringify(shared.body);
  expect(text).not.toContain(threadId);
  expect(text).not.toContain("Secret pricing");
  expect(text).not.toContain("discount");
  for (const path of reads) {
    expect((await stack.api(bea.jar, "GET", path)).body.lastContactedAt).toBe(sentAt.toISOString());
  }

  await mailApi(ana, "PUT", `/mailboxes/${box.id}/crm-sharing`, { level: "subjects" });
  const withSubject = await stack.api(bea.jar, "GET", `/people/${id}/timeline`);
  expect(withSubject.body.items).toContainEqual(
    expect.objectContaining({
      kind: "activity",
      id: activity[0].id,
      activity: expect.objectContaining({ subject: "Secret pricing" }),
    }),
  );
  expect(JSON.stringify(withSubject.body)).not.toContain(threadId);

  // Ana can open the thread: she gets it as a thread, never also as activity.
  const anas = await stack.api(ana.jar, "GET", `/people/${id}/timeline`);
  const kinds = anas.body.items.map((item: { kind: string }) => item.kind);
  expect(kinds).toContain("thread");
  expect(kinds).not.toContain("activity");
  expect((await stack.api(ana.jar, "GET", `/people/${id}`)).body.lastContactedAt).toBe(
    sentAt.toISOString(),
  );

  await mailApi(ana, "PUT", `/mailboxes/${box.id}/crm-sharing`, { level: "off" });
  const after = await stack.api(bea.jar, "GET", `/people/${id}/timeline`);
  expect(after.body.items.map((item: { kind: string }) => item.kind)).not.toContain("activity");
  expect((await stack.api(bea.jar, "GET", `/people/${id}`)).body.lastContactedAt).toBeNull();
});

// Catches: the timeline's cursor not carrying activity items (repeated or skipped on the next
// page) when they interleave with threads and events.
test("activity pages with the rest of the timeline, each item once", async () => {
  const acme = await stack.company("acme-pages");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);
  const box = await personalMailbox(acme.id, ana, "ana@acme-pages.test");
  const added = await stack.api(bea.jar, "POST", "/people", {
    name: "Dora",
    address: "dora@client-pages.test",
  });
  const { id } = added.body.person;
  for (let uid = 1; uid <= 5; uid++) {
    await seedMessage(stack.db, box, {
      subject: `Thread ${uid}`,
      fromAddress: "dora@client-pages.test",
      to: [box.address],
      uid,
      sentAt: new Date(Date.UTC(2026, 10, uid)),
    });
  }
  await mailApi(ana, "PUT", `/mailboxes/${box.id}/crm-sharing`, { level: "subjects" });

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
    const page = await stack.api(bea.jar, "GET", `/people/${id}/timeline${query}`);
    expect(page.status).toBe(200);
    seen.push(
      ...page.body.items
        .filter((item: { kind: string }) => item.kind === "activity")
        .map((item: { activity: { subject: string } }) => item.activity.subject),
    );
    cursor = page.body.nextCursor;
  } while (cursor);
  expect(seen).toEqual(["Thread 5", "Thread 4", "Thread 3", "Thread 2", "Thread 1"]);
});
