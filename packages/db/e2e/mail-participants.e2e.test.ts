// `thread_participants` and `threadsWith` (ADR 0036 decision 4, spec crm.md M1): who sees a
// thread through a participant lookup, how addresses are keyed, and how the index follows the
// mail as threads merge, lose messages and get backfilled.
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { pruneMessages } from "../src/mail/mail-sync.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { mergeThreads } from "../src/mail/thread-merge.ts";
import { indexParticipants, PARTICIPANT_SETTLE_MS } from "../src/mail/thread-participants.ts";
import { createThread, upsertMessage } from "../src/mail/writers.ts";
import {
  mailboxes,
  members,
  threadParticipants,
  threadParticipantsBackfill,
} from "../src/schema/index.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

type Address = { name: string | null; address: string };
const to = (...list: string[]) => {
  const result: Address[] = list.map((address) => ({ name: null, address }));
  return result;
};

let clock = Date.parse("2026-10-01T00:00:00Z");
/** One message in a new thread (or in `threadId`), each later than the last. */
async function mail(
  orgId: string,
  mailboxId: string,
  input: { from: string; to?: string[]; cc?: string[]; threadId?: string; subject?: string },
) {
  const sentAt = new Date((clock += 60_000));
  const threadId =
    input.threadId ??
    (await createThread(db, { orgId, mailboxId, subjectKey: "x", lastMessageAt: sentAt }));
  const stored = await upsertMessage(db, {
    orgId,
    mailboxId,
    threadId,
    messageIdHeader: `<${crypto.randomUUID()}@example.test>`,
    subject: input.subject ?? "Hello",
    fromAddress: input.from,
    to: to(...(input.to ?? [])),
    cc: to(...(input.cc ?? [])),
    sentAt,
    cleanText: "Body text.",
  });
  return { threadId, messageId: stored.id };
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

async function personalMailbox(orgId: string, address: string) {
  const [row] = await db
    .insert(mailboxes)
    .values({ orgId, address, kind: "personal", credentialsEnc: "x" })
    .returning();
  return row!;
}

describe("threadsWith through the member door", () => {
  test("a thread in a shared inbox is returned to a member on that inbox and not to one who is not", async () => {
    const org = await createOrg(db, `tw-shared-${Date.now()}`);
    const other = await createOrg(db, `tw-other-${Date.now()}`);
    const onInbox = await createMember(db, org.id, "on-inbox");
    const offInbox = await createMember(db, org.id, "off-inbox");
    const outsider = await createMember(db, other.id, "outsider");
    const box = await createMailbox(db, org.id, `support-${Date.now()}@team.test`);
    await grant(db, org.id, box.id, onInbox.id);
    // A forged grant from another org opens nothing.
    await grant(db, org.id, box.id, outsider.id);
    const thread = await mail(org.id, box.id, { from: "ana@acme.test", to: [box.address] });

    const query = { addresses: ["ana@acme.test"] };
    expect(ids(await forMember(db, onInbox.id).threadsWith(query))).toEqual([thread.threadId]);
    expect(ids(await forMember(db, onInbox.id).threadsWith({ domains: ["acme.test"] }))).toEqual([
      thread.threadId,
    ]);
    expect(await forMember(db, offInbox.id).threadsWith(query)).toEqual([]);
    expect(await forMember(db, outsider.id).threadsWith(query)).toEqual([]);
    expect(await forUser(db, offInbox.userId).threadsWith(query)).toEqual([]);
    expect(await forUser(db, outsider.userId).threadsWith(query)).toEqual([]);
  });

  test("a thread in a teammate's personal mailbox is returned to nobody else, admins included", async () => {
    const org = await createOrg(db, `tw-personal-${Date.now()}`);
    const owner = await createMember(db, org.id, "owner");
    const admin = await createMember(db, org.id, "admin");
    await db.update(members).set({ role: "admin" }).where(eq(members.id, admin.id));
    const box = await personalMailbox(org.id, `owner-${Date.now()}@team.test`);
    await grant(db, org.id, box.id, owner.id);
    const thread = await mail(org.id, box.id, { from: box.address, to: ["bea@client.test"] });

    const query = { addresses: ["bea@client.test"], domains: ["client.test"] };
    const seen = await forMember(db, owner.id).threadsWith(query);
    expect(seen).toMatchObject([
      { id: thread.threadId, orgId: org.id, mailboxId: box.id, subject: "Hello" },
    ]);
    expect(seen[0]!.snippet).toBe("Body text.");
    expect(await forMember(db, admin.id).threadsWith(query)).toEqual([]);
    expect(await forUser(db, admin.userId).threadsWith(query)).toEqual([]);
  });

  test("an address only ever in Cc is found, and Ana@Acme.com and ana@acme.com are one", async () => {
    const org = await createOrg(db, `tw-cc-${Date.now()}`);
    const member = await createMember(db, org.id, "member");
    const box = await createMailbox(db, org.id, `sales-${Date.now()}@team.test`);
    await grant(db, org.id, box.id, member.id);
    const first = await mail(org.id, box.id, {
      from: "someone@else.test",
      to: [box.address],
      cc: ["Ana@Acme.com"],
    });
    await mail(org.id, box.id, {
      from: box.address,
      to: ["someone@else.test"],
      cc: ["ana@acme.com "],
      threadId: first.threadId,
    });

    const door = forMember(db, member.id);
    for (const address of ["ana@acme.com", "ANA@ACME.COM", " Ana@Acme.com"]) {
      expect(ids(await door.threadsWith({ addresses: [address] }))).toEqual([first.threadId]);
    }
    expect(ids(await door.threadsWith({ domains: ["Acme.COM"] }))).toEqual([first.threadId]);
    const rows = await db
      .select({ address: threadParticipants.address, domain: threadParticipants.domain })
      .from(threadParticipants)
      .where(eq(threadParticipants.threadId, first.threadId))
      .orderBy(threadParticipants.address);
    expect(rows).toEqual([
      { address: "ana@acme.com", domain: "acme.com" },
      { address: box.address, domain: "team.test" },
      { address: "someone@else.test", domain: "else.test" },
    ]);
  });

  test("pages run newest first and the cursor neither repeats nor skips a thread", async () => {
    const org = await createOrg(db, `tw-page-${Date.now()}`);
    const member = await createMember(db, org.id, "member");
    const boxA = await createMailbox(db, org.id, `a-${Date.now()}@team.test`);
    const boxB = await createMailbox(db, org.id, `b-${Date.now()}@team.test`);
    await grant(db, org.id, boxA.id, member.id);
    await grant(db, org.id, boxB.id, member.id);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const box = i % 2 ? boxA : boxB;
      made.push((await mail(org.id, box.id, { from: `p${i}@page.test` })).threadId);
    }
    const door = forMember(db, member.id);
    const seen: string[] = [];
    let before: { lastMessageAt: Date; id: string } | undefined;
    for (;;) {
      const page = await door.threadsWith({ domains: ["page.test"], limit: 2, before });
      if (page.length === 0) break;
      seen.push(...ids(page));
      const last = page.at(-1)!;
      before = { lastMessageAt: last.lastMessageAt, id: last.id };
    }
    expect(seen).toEqual(made.toReversed());
  });
});

test("a session scoped to a company gets no Personal-space threads", async () => {
  const company = await createOrg(db, `tw-company-${Date.now()}`);
  const atCompany = await createMember(db, company.id, "dana");
  const personalOrg = await ensurePersonalSpace(db, atCompany.userId);
  const [inPersonal] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, personalOrg), eq(members.userId, atCompany.userId)));
  const work = await createMailbox(db, company.id, `dana-${Date.now()}@company.test`);
  const gmail = await personalMailbox(personalOrg, `dana-${Date.now()}@gmail.test`);
  await grant(db, company.id, work.id, atCompany.id);
  await grant(db, personalOrg, gmail.id, inPersonal!.id);
  const workThread = await mail(company.id, work.id, { from: "cy@client.test" });
  const personalThread = await mail(personalOrg, gmail.id, { from: "cy@client.test" });

  const query = { addresses: ["cy@client.test"] };
  expect(ids(await forUser(db, atCompany.userId).threadsWith(query)).toSorted()).toEqual(
    [workThread.threadId, personalThread.threadId].toSorted(),
  );
  expect(ids(await forUser(db, atCompany.userId, company.id).threadsWith(query))).toEqual([
    workThread.threadId,
  ]);
});

describe("participants follow the mail", () => {
  test("threads merged into one keep the participants of both", async () => {
    const org = await createOrg(db, `tw-merge-${Date.now()}`);
    const member = await createMember(db, org.id, "member");
    const box = await createMailbox(db, org.id, `merge-${Date.now()}@team.test`);
    await grant(db, org.id, box.id, member.id);
    const parent = await mail(org.id, box.id, { from: "eli@merge.test" });
    const reply = await mail(org.id, box.id, { from: "fay@merge.test" });
    const merged = await mergeThreads(db, {
      mailboxId: box.id,
      threadIds: [parent.threadId, reply.threadId],
    });
    expect(merged.fromThreadIds).toHaveLength(1);

    const door = forMember(db, member.id);
    for (const address of ["eli@merge.test", "fay@merge.test"]) {
      expect(ids(await door.threadsWith({ addresses: [address] }))).toEqual([merged.intoThreadId]);
    }
  });

  test("an address whose only message was deleted on the server no longer finds the thread", async () => {
    const org = await createOrg(db, `tw-prune-${Date.now()}`);
    const member = await createMember(db, org.id, "member");
    const box = await createMailbox(db, org.id, `prune-${Date.now()}@team.test`);
    await grant(db, org.id, box.id, member.id);
    const kept = await mail(org.id, box.id, { from: "gus@prune.test" });
    const gone = await mail(org.id, box.id, {
      from: "hal@prune.test",
      threadId: kept.threadId,
    });
    await pruneMessages(db, { mailboxId: box.id, messageIds: [gone.messageId] });

    const door = forMember(db, member.id);
    expect(ids(await door.threadsWith({ addresses: ["gus@prune.test"] }))).toEqual([kept.threadId]);
    expect(await door.threadsWith({ addresses: ["hal@prune.test"] })).toEqual([]);
  });
});

describe("the backfill", () => {
  const count = async (mailboxId: string) =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(threadParticipants)
        .where(eq(threadParticipants.mailboxId, mailboxId))
    )[0]!.n;

  /** Runs batches of `limit` until one finds nothing; answers how many messages each read. */
  async function backfill(now: Date, limit = 2) {
    const read: number[] = [];
    for (;;) {
      const run = await indexParticipants(db, { limit, now });
      if (run.messages === 0) return read;
      read.push(run.messages);
    }
  }

  // Catches: mail stored before the table, or by an older mail service, never reaching a
  // timeline; a cursor that stops after one batch; and a rerun that duplicates rows.
  test("fills participants for messages stored without them, and a second run changes nothing", async () => {
    const org = await createOrg(db, `tw-backfill-${Date.now()}`);
    const member = await createMember(db, org.id, "member");
    const box = await createMailbox(db, org.id, `old-${Date.now()}@team.test`);
    await grant(db, org.id, box.id, member.id);
    const threadIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      threadIds.push(
        (await mail(org.id, box.id, { from: "old@backfill.test", cc: [`c${i}@x.test`] })).threadId,
      );
    }
    // As the mail stood before this table existed: messages with no participant rows.
    await db.delete(threadParticipants).where(eq(threadParticipants.mailboxId, box.id));
    const door = forMember(db, member.id);
    expect(await door.threadsWith({ addresses: ["old@backfill.test"] })).toEqual([]);

    const later = new Date(Date.now() + PARTICIPANT_SETTLE_MS + 60_000);
    expect((await backfill(later)).length).toBeGreaterThanOrEqual(3);
    expect(ids(await door.threadsWith({ addresses: ["old@backfill.test"] })).toSorted()).toEqual(
      threadIds.toSorted(),
    );
    expect(ids(await door.threadsWith({ addresses: ["c3@x.test"] }))).toEqual([threadIds[3]]);
    // Each thread: the sender and its own Cc.
    expect(await count(box.id)).toBe(10);
    expect(await backfill(later)).toEqual([]);
    expect(await count(box.id)).toBe(10);
  });

  // Catches: a backfill that stops once caught up, so mail an older mail service stores during a
  // deploy (no participant rows) never reaches a timeline; and a cursor that steps past a message
  // too young to be sure every message before it has committed.
  test("keeps following a mailbox after catching up, and never reads past young mail", async () => {
    const org = await createOrg(db, `tw-follow-${Date.now()}`);
    const member = await createMember(db, org.id, "member");
    const box = await createMailbox(db, org.id, `follow-${Date.now()}@team.test`);
    await grant(db, org.id, box.id, member.id);
    await mail(org.id, box.id, { from: "first@follow.test" });
    const settled = new Date(Date.now() + PARTICIPANT_SETTLE_MS + 60_000);
    await backfill(settled);
    const cursor = async () =>
      (
        await db
          .select()
          .from(threadParticipantsBackfill)
          .where(eq(threadParticipantsBackfill.mailboxId, box.id))
      )[0]?.lastMessageId;
    const caughtUp = await cursor();
    expect(caughtUp).toBeDefined();

    // Stored the old way: the message is there, its participants are not.
    const late = await mail(org.id, box.id, { from: "late@follow.test" });
    await db.delete(threadParticipants).where(eq(threadParticipants.threadId, late.threadId));
    // Still young: the cursor waits for it rather than passing it.
    await backfill(new Date());
    expect(await cursor()).toBe(caughtUp);
    expect(await forMember(db, member.id).threadsWith({ addresses: ["late@follow.test"] })).toEqual(
      [],
    );

    await backfill(new Date(Date.now() + PARTICIPANT_SETTLE_MS + 120_000));
    expect(await cursor()).toBe(late.messageId);
    expect(
      ids(await forMember(db, member.id).threadsWith({ addresses: ["late@follow.test"] })),
    ).toEqual([late.threadId]);
  });
});

// Catches: one insert carrying every participant row, which Postgres refuses past 65,535 bound
// parameters (5 a row), so a message sent to a big list never stores and its mailbox's sync
// stalls on it.
test("a message to 14,000 addresses stores, with every participant", async () => {
  const org = await createOrg(db, `tw-many-${Date.now()}`);
  const box = await createMailbox(db, org.id, `list-${Date.now()}@team.test`);
  const list = Array.from({ length: 14_000 }, (_, i) => `r${i}@list.test`);
  const sent = await mail(org.id, box.id, { from: box.address, to: list });
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(threadParticipants)
    .where(eq(threadParticipants.threadId, sent.threadId));
  expect(rows[0]!.n).toBe(14_001);
});
