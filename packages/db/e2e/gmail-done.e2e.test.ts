// A Google account's read state is Omni's Done (ADR 0044), proven on the sync writers the mail
// service calls: flags as Gmail reports them in, per-member state out.
import { and, eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { addLocation, reconcileFolder, setLocationFlags } from "../src/mail/mail-sync.ts";
import { forMember } from "../src/for-member.ts";
import { threadActionTargets } from "../src/mail/member-mail.ts";
import { mailboxes, messageLocations, threadState } from "../src/schema/index.ts";
import { createThread, upsertFolder, upsertMessage } from "../src/mail/writers.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const org = await createOrg(db, "gmail-done-org");
const member = await createMember(db, org.id, "ana");

/** A personal mailbox of `provider` with an INBOX, owned by the member. */
async function account(address: string, provider: "gmail" | "imap") {
  const mailbox = await createMailbox(db, org.id, address);
  await db
    .update(mailboxes)
    .set({ kind: "personal", provider })
    .where(eq(mailboxes.id, mailbox.id));
  await grant(db, org.id, mailbox.id, member.id);
  const inbox = await upsertFolder(db, {
    orgId: org.id,
    mailboxId: mailbox.id,
    path: "INBOX",
    role: "inbox",
    uidvalidity: 1,
    uidnext: 100,
    highestModseq: 1n,
  });
  let uid = 0;
  /**
   * Indexes a message the way the mail service does: the row, then its INBOX copy. They are
   * separate writes, so a sync that fails between them and retries looks exactly like this.
   */
  const deliver = async (threadId: string | null, sentAt: Date, flags: string[]) => {
    uid += 1;
    const thread =
      threadId ??
      (await createThread(db, {
        orgId: org.id,
        mailboxId: mailbox.id,
        subjectKey: `subject-${uid}`,
        lastMessageAt: sentAt,
      }));
    const message = await upsertMessage(db, {
      orgId: org.id,
      mailboxId: mailbox.id,
      threadId: thread,
      messageIdHeader: `<${uid}@${address}>`,
      fromAddress: "luis@client.test",
      sentAt,
    });
    await addLocation(db, {
      orgId: org.id,
      mailboxId: mailbox.id,
      folderId: inbox.id,
      uid,
      messageId: message.id,
      flags,
      modseq: null,
      report: false,
    });
    return { threadId: thread, uid };
  };
  const flag = (uids: number[], flags: string[]) =>
    setLocationFlags(db, {
      mailboxId: mailbox.id,
      path: "INBOX",
      changes: uids.map((u) => ({ uid: u, flags, modseq: null })),
    });
  return { mailbox, deliver, flag };
}

async function stateOf(threadId: string) {
  const [row] = await db
    .select({
      read: threadState.read,
      doneThrough: threadState.doneThrough,
      snoozedUntil: threadState.snoozedUntil,
    })
    .from(threadState)
    .where(eq(threadState.threadId, threadId));
  return row;
}

const inbox = async () =>
  (await forMember(db, member.id).listThreads({ view: "inbox" })).map((t) => t.id);
const SEEN = ["\\Seen"];

test("mail read in Gmail is Done in Omni, and marking it unread there reopens it", async () => {
  const { deliver, flag } = await account("ana@gmail-done.test", "gmail");
  const at = new Date("2026-11-01T09:00:00Z");
  const { threadId, uid } = await deliver(null, at, []);
  expect(await inbox()).toContain(threadId);

  // In Later when Gmail reports it read: done wins and the thread leaves Later.
  await forMember(db, member.id).setThreadState(threadId, { later: true });
  await flag([uid], SEEN);
  expect(await stateOf(threadId)).toEqual({ read: true, doneThrough: at, snoozedUntil: null });
  expect(await inbox()).not.toContain(threadId);

  await flag([uid], []);
  expect(await stateOf(threadId)).toMatchObject({ read: false, doneThrough: null });
  expect(await inbox()).toContain(threadId);
});

test("opening a thread in Omni stays in Omni: a sync does not undo it, new unread mail does", async () => {
  const { deliver, flag } = await account("bea@gmail-done.test", "gmail");
  const first = await deliver(null, new Date("2026-11-01T09:00:00Z"), []);
  await forMember(db, member.id).setThreadState(first.threadId, { read: true });

  // Gmail still has it unread. A flag change that says nothing about read (a star) must not
  // turn the thread unread in Omni again, nor make it done.
  await flag([first.uid], ["\\Flagged"]);
  expect(await stateOf(first.threadId)).toMatchObject({ read: true, doneThrough: null });

  // Done, then a reply arrives unread: back in the Inbox, unread.
  await flag([first.uid], SEEN);
  expect(await inbox()).not.toContain(first.threadId);
  await deliver(first.threadId, new Date("2026-11-02T09:00:00Z"), []);
  expect(await stateOf(first.threadId)).toMatchObject({ read: false, doneThrough: null });
  expect(await inbox()).toContain(first.threadId);
});

test("mail already read in Gmail becomes Done when the folder is reconciled", async () => {
  const { mailbox, deliver } = await account("cora@gmail-done.test", "gmail");
  const at = new Date("2026-11-01T09:00:00Z");
  const read = await deliver(null, at, []);
  const unread = await deliver(null, at, []);
  // As stored before Omni followed Gmail's read state: the flag is there, the state is not.
  await db
    .update(messageLocations)
    .set({ flags: SEEN })
    .where(and(eq(messageLocations.mailboxId, mailbox.id), eq(messageLocations.imapUid, read.uid)));
  expect(await stateOf(read.threadId)).toBeUndefined();

  expect(await reconcileFolder(db, { mailboxId: mailbox.id, path: "INBOX" })).toBe(1);
  expect(await stateOf(read.threadId)).toMatchObject({ read: true, doneThrough: at });
  expect(await stateOf(unread.threadId)).toBeUndefined();
});

test("another personal mailbox keeps read as read: \\Seen never marks it done", async () => {
  const { deliver, flag } = await account("dan@imap-done.test", "imap");
  const { threadId, uid } = await deliver(null, new Date("2026-11-01T09:00:00Z"), []);
  await flag([uid], SEEN);
  expect(await stateOf(threadId)).toEqual({ read: true, doneThrough: null, snoozedUntil: null });
  expect(await inbox()).toContain(threadId);
});

test("the copies Done marks read stop at the done watermark: a reply indexed after it stays unread", async () => {
  const { deliver } = await account("eva@gmail-done.test", "gmail");
  const seen = new Date("2026-11-01T09:00:00Z");
  const first = await deliver(null, seen, []);
  // Arrives between the Done write and the lookup of what to mark read.
  const late = await deliver(first.threadId, new Date("2026-11-01T09:05:00Z"), []);

  const upTo = await threadActionTargets(db, member.id, first.threadId, seen);
  expect(upTo?.targets.map((t) => t.uids)).toEqual([[first.uid]]);
  const newest = await threadActionTargets(db, member.id, first.threadId, "newest");
  expect(newest?.targets.map((t) => t.uids)).toEqual([[late.uid]]);
});

test("a copy found again after a folder reset is not new mail: a thread opened in Omni stays read", async () => {
  const { mailbox, deliver } = await account("fay@gmail-done.test", "gmail");
  const { threadId, uid } = await deliver(null, new Date("2026-11-01T09:00:00Z"), []);
  await forMember(db, member.id).setThreadState(threadId, { read: true });

  // UIDVALIDITY changed: the folder's locations are dropped and its mail is indexed again. The
  // message row survives, so its copy comes back as its only location, still unread in Gmail.
  const [copy] = await db
    .delete(messageLocations)
    .where(and(eq(messageLocations.mailboxId, mailbox.id), eq(messageLocations.imapUid, uid)))
    .returning();
  if (!copy) throw new Error("no location");
  await addLocation(db, {
    orgId: org.id,
    mailboxId: mailbox.id,
    folderId: copy.folderId,
    uid: uid + 50,
    messageId: copy.messageId,
    flags: [],
    modseq: null,
  });
  expect(await stateOf(threadId)).toMatchObject({ read: true, doneThrough: null });
});
