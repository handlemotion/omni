import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { threadState, threads } from "../src/schema/index.ts";
import { createThread, upsertMessage } from "../src/writers.ts";
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
    await asBob.setThreadState(billing.threadId, { snoozedUntil: new Date("2027-01-01Z") });
    const [thread] = await asBob.listThreads();
    expect(thread).toMatchObject({ read: true, snoozedUntil: new Date("2027-01-01Z") });
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
