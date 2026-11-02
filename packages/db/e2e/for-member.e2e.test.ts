import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { threadState, threads } from "../src/schema/index.ts";
import { createThread, enqueueAction, upsertMessage } from "../src/writers.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

async function seedThread(
  orgId: string,
  mailboxId: string,
  text: string,
  triage?: { bucket: "needs_reply" | "fyi"; confidence: number; source: "ai" | "person" },
) {
  const threadId = await createThread(db, {
    orgId,
    mailboxId,
    subjectKey: text,
    lastMessageAt: new Date("2026-10-01T00:00:00Z"),
  });
  if (triage) {
    await db
      .update(threads)
      .set({
        triage: triage.bucket,
        triageConfidence: triage.confidence,
        triageSource: triage.source,
      })
      .where(eq(threads.id, threadId));
  }
  const message = await upsertMessage(db, {
    orgId,
    mailboxId,
    threadId,
    messageIdHeader: `<${threadId}@example.test>`,
    subject: `About ${text}`,
    fromAddress: "sender@example.test",
    sentAt: new Date("2026-10-01T00:00:00Z"),
    cleanText: `Please look at the ${text} details.`,
  });
  return { threadId, messageId: message.id };
}

describe("forMember isolation", () => {
  // Org A: alice sees hello@, bob sees billing@. Org B: carol sees ops@, and holds a forged
  // grant on org A's hello@ (a buggy or malicious write must not open another org's mail).
  let alice: string, bob: string, carol: string;
  let hello: { threadId: string; messageId: string };
  let billing: { threadId: string; messageId: string };
  let ops: { threadId: string; messageId: string };

  beforeAll(async () => {
    const orgA = await createOrg(db, "org-a");
    const orgB = await createOrg(db, "org-b");
    alice = (await createMember(db, orgA.id, "alice")).id;
    bob = (await createMember(db, orgA.id, "bob")).id;
    carol = (await createMember(db, orgB.id, "carol")).id;
    const helloBox = await createMailbox(db, orgA.id, "hello@a.test");
    const billingBox = await createMailbox(db, orgA.id, "billing@a.test");
    const opsBox = await createMailbox(db, orgB.id, "ops@b.test");
    await grant(db, orgA.id, helloBox.id, alice);
    await grant(db, orgA.id, billingBox.id, bob);
    await grant(db, orgB.id, opsBox.id, carol);
    await grant(db, orgA.id, helloBox.id, carol);
    hello = await seedThread(orgA.id, helloBox.id, "pelican");
    billing = await seedThread(orgA.id, billingBox.id, "flamingo");
    ops = await seedThread(orgB.id, opsBox.id, "albatross");
  });

  test("a member reads only threads, messages and search hits from mailboxes they were granted", async () => {
    const asAlice = forMember(db, alice);
    expect((await asAlice.listThreads()).map((t) => t.id)).toEqual([hello.threadId]);
    expect((await asAlice.getThread(hello.threadId))?.messages.map((m) => m.id)).toEqual([
      hello.messageId,
    ]);
    expect(await asAlice.getThread(billing.threadId)).toBeNull();
    expect(await asAlice.getThread(ops.threadId)).toBeNull();
    expect(await asAlice.search("flamingo")).toEqual([]);
    expect(await asAlice.search("albatross")).toEqual([]);

    // Bob, same org, other mailbox: the hit exists, so the empty results above are scoping.
    expect((await forMember(db, bob).search("flamingo")).map((h) => h.messageId)).toEqual([
      billing.messageId,
    ]);
  });

  test("a grant that crosses orgs opens nothing", async () => {
    const asCarol = forMember(db, carol);
    expect((await asCarol.listThreads()).map((t) => t.id)).toEqual([ops.threadId]);
    expect(await asCarol.getThread(hello.threadId)).toBeNull();
    expect(await asCarol.search("pelican")).toEqual([]);
    expect(await asCarol.setThreadState(hello.threadId, { read: true })).toBeNull();
  });

  test("thread state is per member and cannot be written without access", async () => {
    expect(await forMember(db, alice).setThreadState(billing.threadId, { read: true })).toBeNull();
    expect(
      await db.select().from(threadState).where(eq(threadState.threadId, billing.threadId)),
    ).toEqual([]);

    const asBob = forMember(db, bob);
    await asBob.setThreadState(billing.threadId, { read: true });
    const snoozedUntil = new Date(Date.now() + 86_400_000);
    await asBob.setThreadState(billing.threadId, { snoozedUntil });
    const [thread] = await asBob.listThreads({ view: "snoozed" });
    expect(thread).toMatchObject({ id: billing.threadId, read: true, snoozedUntil });
  });

  test("counts and outbox actions are scoped like threads", async () => {
    const { orgId, mailboxId: helloBox } = (await forMember(db, alice).getThread(hello.threadId))!;
    // Alice counts only hello@; Carol's forged cross-org grant on hello@ yields no row at all.
    expect((await forMember(db, alice).counts()).map((c) => c.mailboxId)).toEqual([helloBox]);
    expect((await forMember(db, carol).counts()).map((c) => c.mailboxId)).not.toContain(helloBox);

    const action = await enqueueAction(db, {
      orgId,
      mailboxId: helloBox,
      memberId: alice,
      kind: "send",
      payload: {},
      idempotencyKey: `isolation-${alice}`,
    });
    expect(await forMember(db, alice).getAction(action.id)).toMatchObject({ id: action.id });
    // Bob shares Alice's org but did not ask for it; Carol is in another org.
    expect(await forMember(db, bob).getAction(action.id)).toBeNull();
    expect(await forMember(db, carol).getAction(action.id)).toBeNull();
  });
});

test("full-text search matches stemmed words in clean_text", async () => {
  const org = await createOrg(db, "search-org");
  const member = (await createMember(db, org.id, "dana")).id;
  const box = await createMailbox(db, org.id, "dana@search.test");
  await grant(db, org.id, box.id, member);
  const { messageId } = await seedThread(org.id, box.id, "quarterly invoicing");

  const hits = await forMember(db, member).search("invoices");
  expect(hits.map((h) => h.messageId)).toEqual([messageId]);
});

test("lanes split AI triage at the auto-file confidence; person triage always files", async () => {
  const org = await createOrg(db, "lane-org");
  const member = (await createMember(db, org.id, "eve")).id;
  const box = await createMailbox(db, org.id, "eve@lane.test");
  await grant(db, org.id, box.id, member);
  const sure = await seedThread(org.id, box.id, "sure", {
    bucket: "needs_reply",
    confidence: 0.9,
    source: "ai",
  });
  const unsure = await seedThread(org.id, box.id, "unsure", {
    bucket: "needs_reply",
    confidence: 0.6,
    source: "ai",
  });
  const person = await seedThread(org.id, box.id, "person", {
    bucket: "needs_reply",
    confidence: 0.1,
    source: "person",
  });

  const scoped = forMember(db, member);
  const ids = async (lane: "needs_reply" | "unsure") =>
    (await scoped.listThreads({ lane })).map((t) => t.id).toSorted();
  expect(await ids("needs_reply")).toEqual([sure.threadId, person.threadId].toSorted());
  expect(await ids("unsure")).toEqual([unsure.threadId]);
});

test("thread pages and search merge granted mailboxes newest first, each row once, ties included", async () => {
  // Lists and search take the newest rows of each granted mailbox and merge them, so a page
  // boundary that falls on a timestamp shared across mailboxes is where rows get lost or repeated.
  const org = await createOrg(db, "page-org");
  const member = (await createMember(db, org.id, "frank")).id;
  const sales = await createMailbox(db, org.id, "sales@page.test");
  const support = await createMailbox(db, org.id, "support@page.test");
  const hidden = await createMailbox(db, org.id, "hidden@page.test");
  await grant(db, org.id, sales.id, member);
  await grant(db, org.id, support.id, member);

  const at = (day: number) => new Date(Date.UTC(2026, 9, day));
  const days = [5, 4, 4, 4, 3, 2, 1];
  const seeded: { threadId: string; messageId: string; mailboxId: string; sentAt: Date }[] = [];
  for (const [i, day] of days.entries()) {
    const mailboxId = [sales.id, support.id, hidden.id][i % 3]!;
    const threadId = await createThread(db, {
      orgId: org.id,
      mailboxId,
      subjectKey: `walrus ${i}`,
      lastMessageAt: at(day),
    });
    const { id } = await upsertMessage(db, {
      orgId: org.id,
      mailboxId,
      threadId,
      messageIdHeader: `<walrus-${i}@page.test>`,
      subject: `Walrus ${i}`,
      fromAddress: "sender@example.test",
      sentAt: at(day),
      cleanText: "walrus migration notes",
    });
    seeded.push({ threadId, messageId: id, mailboxId, sentAt: at(day) });
  }
  const visible = seeded
    .filter((s) => s.mailboxId !== hidden.id)
    .toSorted(
      (a, b) => b.sentAt.getTime() - a.sentAt.getTime() || (a.threadId < b.threadId ? 1 : -1),
    );

  const scoped = forMember(db, member);
  const paged: string[] = [];
  let before: { lastMessageAt: Date; id: string } | undefined;
  for (;;) {
    const page = await scoped.listThreads({ limit: 2, before });
    if (page.length === 0) break;
    expect(page.length).toBeLessThanOrEqual(2);
    paged.push(...page.map((t) => t.id));
    const last = page.at(-1)!;
    before = { lastMessageAt: last.lastMessageAt, id: last.id };
  }
  expect(paged).toEqual(visible.map((s) => s.threadId));

  // Thread ids are UUIDv7 in creation order, and so are message ids here: same tie order.
  const hits = await scoped.search("walrus", { limit: 3 });
  expect(hits.map((h) => h.messageId)).toEqual(visible.slice(0, 3).map((s) => s.messageId));
});
