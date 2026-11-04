import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { createDb } from "../src/client.ts";
import { rescheduleAction, setLocationFlags } from "../src/mail-sync.ts";
import {
  attachments,
  mailActions,
  messageLocations,
  messages,
  threads,
} from "../src/schema/index.ts";
import {
  claimActions,
  completeAction,
  createThread,
  enqueueAction,
  upsertFolder,
  upsertMessage,
} from "../src/writers.ts";
import { createMailbox, createOrg, createTestDatabase } from "./support.ts";

const { db, url, teardown } = await createTestDatabase();
afterAll(teardown);

const org = await createOrg(db, "writers-org");
const mailbox = await createMailbox(db, org.id, "inbox@writers.test");

describe("upsertMessage", () => {
  test("a re-synced message converges on one row, keeps its attachments once, and tracks moves", async () => {
    const inbox = await upsertFolder(db, {
      orgId: org.id,
      mailboxId: mailbox.id,
      path: "INBOX",
      role: "inbox",
      uidvalidity: 1,
      uidnext: 10,
      highestModseq: 5n,
    });
    const archive = await upsertFolder(db, {
      orgId: org.id,
      mailboxId: mailbox.id,
      path: "Archive",
      role: "archive",
      uidvalidity: 1,
      uidnext: 3,
      highestModseq: 2n,
    });
    const threadId = await createThread(db, {
      orgId: org.id,
      mailboxId: mailbox.id,
      subjectKey: "contract",
      lastMessageAt: new Date("2026-10-05T00:00:00Z"),
    });
    const input = {
      orgId: org.id,
      mailboxId: mailbox.id,
      threadId,
      folderId: inbox.id,
      imapUid: 7,
      messageIdHeader: "<contract-1@example.test>",
      subject: "Contract",
      fromAddress: "ana@example.test",
      sentAt: new Date("2026-10-01T00:00:00Z"),
      cleanText: "Signed copy attached.",
      attachments: [
        { filename: "contract.pdf", mimeType: "application/pdf", size: 10, r2Key: "a" },
      ],
    };

    const first = await upsertMessage(db, input);
    const again = await upsertMessage(db, input);
    const moved = await upsertMessage(db, { ...input, folderId: archive.id, imapUid: 2 });

    expect(first.inserted).toBe(true);
    expect(again).toEqual({ ...first, inserted: false });
    expect(moved.id).toBe(first.id);
    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailbox.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ folderId: archive.id, imapUid: 2 });
    expect(
      await db.select().from(attachments).where(eq(attachments.messageId, first.id)),
    ).toHaveLength(1);
    // An older message never drags the thread's recency backwards.
    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread!.lastMessageAt).toEqual(new Date("2026-10-05T00:00:00Z"));
  });
});

describe("mail_actions outbox", () => {
  const enqueue = (key: string) =>
    enqueueAction(db, {
      orgId: org.id,
      mailboxId: mailbox.id,
      memberId: null,
      kind: "archive",
      payload: { folder: "INBOX", uidValidity: "1", uids: [1] },
      idempotencyKey: key,
    });

  test("the same idempotency key enqueues one action", async () => {
    const a = await enqueue("send-once");
    const b = await enqueue("send-once");
    expect(b.id).toBe(a.id);
    expect(
      await db.select().from(mailActions).where(eq(mailActions.idempotencyKey, "send-once")),
    ).toHaveLength(1);
    await db.delete(mailActions);
  });

  test("concurrent claimers never receive the same action", async () => {
    const total = 60;
    for (let i = 0; i < total; i++) await enqueue(`concurrent-${i}`);

    // Separate connection pools, so the claims really race inside Postgres.
    const workers = Array.from({ length: 6 }, () => createDb(url, { max: 2 }));
    try {
      const claimed = await Promise.all(
        workers.map(async ({ db: worker }) => {
          const ids: string[] = [];
          for (;;) {
            const batch = await claimActions(worker, { limit: 3 });
            if (batch.length === 0) return ids;
            ids.push(...batch.map((a) => a.id));
          }
        }),
      );
      const all = claimed.flat();
      expect(all).toHaveLength(total);
      expect(new Set(all).size).toBe(total);
      expect(claimed.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
      await db.delete(mailActions);
    }
  });

  test("a retry waits for its time, a final failure stays failed, and done rows stay done", async () => {
    const action = await enqueue("flaky");
    const [first] = await claimActions(db);
    expect(first).toMatchObject({ id: action.id, attempts: 1 });
    const later = new Date(Date.now() + 60_000);
    expect(await rescheduleAction(db, action.id, "boom 1", later)).toMatchObject({
      status: "pending",
    });
    expect(await claimActions(db)).toEqual([]); // not due yet
    await db
      .update(mailActions)
      .set({ runAfter: sql`now()` })
      .where(eq(mailActions.id, action.id));
    const [second] = await claimActions(db);
    expect(second).toMatchObject({ id: action.id, attempts: 2 });
    expect(await rescheduleAction(db, action.id, "boom 2", null)).toMatchObject({
      status: "failed",
    });
    expect(await claimActions(db)).toEqual([]);

    const ok = await enqueue("ok");
    await claimActions(db);
    expect(await completeAction(db, ok.id)).toBe(true);
    expect(await completeAction(db, ok.id)).toBe(false);
    expect(await claimActions(db)).toEqual([]);
  });
});

test("setLocationFlags rewrites the named folder's copies and leaves the same UIDs elsewhere alone", async () => {
  // UIDs are per folder, so UID 1 exists in every folder of every mailbox. A batch update that
  // matched on UID alone would rewrite the flags of unrelated copies.
  const other = await createMailbox(db, org.id, "other@writers.test");
  const folders = await Promise.all(
    [
      [mailbox.id, "Flags/A"],
      [mailbox.id, "Flags/B"],
      [other.id, "Flags/A"],
    ].map(([mailboxId, path]) =>
      upsertFolder(db, {
        orgId: org.id,
        mailboxId: mailboxId!,
        path: path!,
        role: "other",
        uidvalidity: 1,
        uidnext: 3,
        highestModseq: 1n,
      }),
    ),
  );
  for (const folder of folders) {
    const threadId = await createThread(db, {
      orgId: org.id,
      mailboxId: folder.mailboxId,
      subjectKey: "flags",
      lastMessageAt: new Date(),
    });
    for (const uid of [1, 2]) {
      const { id } = await upsertMessage(db, {
        orgId: org.id,
        mailboxId: folder.mailboxId,
        threadId,
        messageIdHeader: `<flags-${folder.id}-${uid}@writers.test>`,
        fromAddress: "a@example.test",
        sentAt: new Date(),
      });
      await db.insert(messageLocations).values({
        orgId: org.id,
        mailboxId: folder.mailboxId,
        folderId: folder.id,
        imapUid: uid,
        messageId: id,
      });
    }
  }

  await setLocationFlags(db, {
    mailboxId: mailbox.id,
    path: "Flags/A",
    changes: [
      { uid: 1, flags: ["\\Flagged", "\\Seen"], modseq: 9_007_199_254_740_993n },
      { uid: 2, flags: [], modseq: null },
    ],
  });

  const rows = await db
    .select({
      folderId: messageLocations.folderId,
      uid: messageLocations.imapUid,
      flags: messageLocations.flags,
      modseq: messageLocations.modseq,
    })
    .from(messageLocations)
    .where(sql`${messageLocations.folderId} in ${folders.map((f) => f.id)}`);
  const at = (folderIndex: number, uid: number) =>
    rows.find((r) => r.folderId === folders[folderIndex]!.id && r.uid === uid);
  expect(at(0, 1)).toMatchObject({
    flags: ["\\Flagged", "\\Seen"],
    modseq: 9_007_199_254_740_993n,
  });
  expect(at(0, 2)).toMatchObject({ flags: [], modseq: null });
  for (const untouched of [at(1, 1), at(1, 2), at(2, 1), at(2, 2)]) {
    expect(untouched).toMatchObject({ flags: [], modseq: null });
  }
});
