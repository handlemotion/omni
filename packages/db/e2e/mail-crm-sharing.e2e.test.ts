import { and, eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { createThread, upsertMessage } from "../src/mail/writers.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { mailboxAccess, mailboxCrmSharing, mailboxes, members } from "../src/schema/index.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

let clock = Date.parse("2026-10-01T00:00:00Z");
async function mail(
  orgId: string,
  mailboxId: string,
  input: { from: string; to: string; subject: string; threadId?: string },
) {
  const sentAt = new Date((clock += 60_000));
  const threadId =
    input.threadId ??
    (await createThread(db, { orgId, mailboxId, subjectKey: "x", lastMessageAt: sentAt }));
  await upsertMessage(db, {
    orgId,
    mailboxId,
    threadId,
    messageIdHeader: `<${crypto.randomUUID()}@example.test>`,
    subject: input.subject,
    fromAddress: input.from,
    to: [{ name: null, address: input.to }],
    sentAt,
    cleanText: "The body nobody else may read.",
  });
  return { threadId, sentAt };
}

async function role(memberId: string, value: "owner" | "admin" | "member") {
  await db.update(members).set({ role: value }).where(eq(members.id, memberId));
}

async function personalMailbox(orgId: string, ownerId: string, address: string) {
  const [box] = await db
    .insert(mailboxes)
    .values({ orgId, address, kind: "personal", credentialsEnc: "x" })
    .returning();
  await db
    .insert(mailboxAccess)
    .values({ orgId, mailboxId: box!.id, memberId: ownerId, role: "owner" });
  return box!;
}

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function company(slug: string) {
  const org = await createOrg(db, `${slug}-${Date.now()}`);
  const ana = await createMember(db, org.id, "Ana Lima");
  const bea = await createMember(db, org.id, "Bea");
  const admin = await createMember(db, org.id, "Admin");
  await role(admin.id, "admin");
  const box = await personalMailbox(org.id, ana.id, `ana-${Date.now()}@team.test`);
  const received = await mail(org.id, box.id, {
    from: "cy@client.test",
    to: box.address,
    subject: "Renewal terms",
  });
  const reply = await mail(org.id, box.id, {
    from: box.address.toUpperCase(),
    to: "cy@client.test",
    subject: "Re: Renewal terms",
    threadId: received.threadId,
  });
  return { org, ana, bea, admin, box, threadId: received.threadId, lastAt: reply.sentAt };
}

const query = { addresses: ["Cy@Client.test"] };

test("off by default shows a teammate nothing; activity shows who and when; subjects adds the subject; off hides it again", async () => {
  const { org, ana, bea, box, lastAt } = await company("share-levels");
  const beaMail = forMember(db, bea.id);
  expect(await beaMail.sharedActivityWith(query)).toEqual([]);
  expect(ok(await forMember(db, ana.id).crmSharing(box.id)).level).toBe("off");

  ok(await forMember(db, ana.id).setCrmSharing(box.id, "activity"));
  const seen = await beaMail.sharedActivityWith(query);
  expect(seen).toEqual([
    {
      key: expect.any(String),
      mailbox: { kind: "personal", name: "Ana Lima" },
      lastMessageAt: lastAt,
      direction: "out",
      subject: null,
    },
  ]);
  expect(await beaMail.sharedActivityWith({ domains: ["client.test"] })).toEqual(seen);

  ok(await forMember(db, ana.id).setCrmSharing(box.id, "subjects"));
  expect(await beaMail.sharedActivityWith(query)).toMatchObject([
    { key: seen[0]!.key, subject: "Re: Renewal terms" },
  ]);

  ok(await forMember(db, ana.id).setCrmSharing(box.id, "off"));
  expect(await beaMail.sharedActivityWith(query)).toEqual([]);
  const [row] = await db
    .select()
    .from(mailboxCrmSharing)
    .where(eq(mailboxCrmSharing.mailboxId, box.id));
  expect(row).toMatchObject({ orgId: org.id, level: "off", updatedByMemberId: ana.id });
});

test("a member who can open the mailbox gets nothing from it here: its threads come from threadsWith", async () => {
  const { org, ana, bea, threadId } = await company("share-own");
  const inbox = await createMailbox(db, org.id, `support-${Date.now()}@team.test`);
  await grant(db, org.id, inbox.id, bea.id);
  await role(bea.id, "admin");
  const shared = await mail(org.id, inbox.id, {
    from: "cy@client.test",
    to: inbox.address,
    subject: "Ticket",
  });
  ok(await forMember(db, bea.id).setCrmSharing(inbox.id, "subjects"));

  expect(await forMember(db, bea.id).sharedActivityWith(query)).toEqual([]);
  expect((await forMember(db, bea.id).threadsWith(query)).map((t) => t.id)).toEqual([
    shared.threadId,
  ]);
  const anas = await forMember(db, ana.id).sharedActivityWith(query);
  expect(anas).toMatchObject([
    { mailbox: { kind: "shared", name: inbox.address }, direction: "in", subject: "Ticket" },
  ]);
  expect((await forMember(db, ana.id).threadsWith(query)).map((t) => t.id)).toEqual([threadId]);
});

test("only a personal mailbox's owner sets it; a shared inbox's owners and admins; nobody from another workspace", async () => {
  const { ana, bea, admin, box, org } = await company("share-who");
  expect(await forMember(db, admin.id).setCrmSharing(box.id, "subjects")).toEqual({
    status: "forbidden",
  });
  expect(await forMember(db, admin.id).crmSharing(box.id)).toEqual({ status: "forbidden" });
  expect(await forMember(db, bea.id).setCrmSharing(box.id, "activity")).toEqual({
    status: "forbidden",
  });
  expect(
    await db.select().from(mailboxCrmSharing).where(eq(mailboxCrmSharing.mailboxId, box.id)),
  ).toEqual([]);

  const inbox = await createMailbox(db, org.id, `sales-${Date.now()}@team.test`);
  await grant(db, org.id, inbox.id, bea.id);
  expect(await forMember(db, bea.id).setCrmSharing(inbox.id, "activity")).toEqual({
    status: "forbidden",
  });
  expect(ok(await forMember(db, admin.id).setCrmSharing(inbox.id, "activity")).level).toBe(
    "activity",
  );

  const other = await createOrg(db, `share-who-other-${Date.now()}`);
  const outsider = await createMember(db, other.id, "Outsider");
  await role(outsider.id, "owner");
  expect(await forMember(db, outsider.id).setCrmSharing(inbox.id, "off")).toEqual({
    status: "not_found",
  });
  expect(ok(await forMember(db, ana.id).setCrmSharing(box.id, "activity")).level).toBe("activity");
});

test("another workspace never sees a company's shared activity", async () => {
  const { ana, box } = await company("share-cross");
  ok(await forMember(db, ana.id).setCrmSharing(box.id, "subjects"));
  const other = await createOrg(db, `share-cross-other-${Date.now()}`);
  const outsider = await createMember(db, other.id, "Outsider");
  expect(await forMember(db, outsider.id).sharedActivityWith(query)).toEqual([]);
  expect(await forMember(db, outsider.id).sharedActivityWith({ domains: ["client.test"] })).toEqual(
    [],
  );
});

test("a Personal space shares its mail with the teammates it invites", async () => {
  const { ana } = await company("share-personal");
  const personalOrg = await ensurePersonalSpace(db, ana.userId);
  const [inPersonal] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, personalOrg), eq(members.userId, ana.userId)));
  const gmail = await personalMailbox(personalOrg, inPersonal!.id, `ana-${Date.now()}@gmail.test`);
  await mail(personalOrg, gmail.id, { from: "cy@client.test", to: gmail.address, subject: "Hi" });
  expect(await forMember(db, inPersonal!.id).setCrmSharing(gmail.id, "subjects")).toEqual({
    status: "ok",
    level: "subjects",
  });
  const hire = await createMember(db, personalOrg, "First hire");
  expect(await forMember(db, hire.id).sharedActivityWith(query)).toEqual([
    expect.objectContaining({ subject: "Hi" }),
  ]);
});

test("nothing in an item names the thread, and the key pages stably, newest first", async () => {
  const { org, ana, bea, box, threadId } = await company("share-opaque");
  const later = await mail(org.id, box.id, {
    from: "dee@client.test",
    to: box.address,
    subject: "Later",
  });
  const newest = await mail(org.id, box.id, {
    from: "eve@client.test",
    to: box.address,
    subject: "Newest",
  });
  ok(await forMember(db, ana.id).setCrmSharing(box.id, "subjects"));
  const beaMail = forMember(db, bea.id);
  const all = await beaMail.sharedActivityWith({ domains: ["client.test"] });
  expect(all.map((item) => item.subject)).toEqual(["Newest", "Later", "Re: Renewal terms"]);
  const text = JSON.stringify(all);
  for (const id of [threadId, later.threadId, newest.threadId]) expect(text).not.toContain(id);
  expect(text).not.toContain("body nobody");
  for (const item of all) {
    expect(Object.keys(item).toSorted()).toEqual(
      ["direction", "key", "lastMessageAt", "mailbox", "subject"].toSorted(),
    );
  }
  expect(await beaMail.sharedActivityWith({ domains: ["client.test"] })).toEqual(all);

  const first = await beaMail.sharedActivityWith({ domains: ["client.test"], limit: 2 });
  const last = first.at(-1)!;
  const rest = await beaMail.sharedActivityWith({
    domains: ["client.test"],
    limit: 2,
    before: { lastMessageAt: last.lastMessageAt, key: last.key },
  });
  expect([...first, ...rest]).toEqual(all);
});
