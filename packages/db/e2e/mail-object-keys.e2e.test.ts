import { createHash } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { findMemberAttachmentByHash } from "../src/mail/member-mail.ts";
import { createThread, upsertMessage } from "../src/mail/writers.ts";
import { mailObjectKeys } from "../src/schema/index.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

test("an attachment the mail service keys by content hash is found by that hash, only through a grant", async () => {
  const org = await createOrg(db, "object-keys-org");
  const ana = await createMember(db, org.id, "ana");
  const bo = await createMember(db, org.id, "bo");
  const mailbox = await createMailbox(db, org.id, "ana@keys.test");
  await grant(db, org.id, mailbox.id, ana.id);
  const threadId = await createThread(db, {
    orgId: org.id,
    mailboxId: mailbox.id,
    subjectKey: "logo",
    lastMessageAt: new Date(),
  });
  const sha256 = createHash("sha256").update("logo bytes").digest("hex");
  const r2Key = mailObjectKeys(`${org.id}/${mailbox.id}`).attachment(sha256);
  await upsertMessage(db, {
    orgId: org.id,
    mailboxId: mailbox.id,
    threadId,
    messageIdHeader: "<logo@keys.test>",
    fromAddress: "luis@client.test",
    sentAt: new Date(),
    attachments: [{ filename: "logo.png", mimeType: "image/png", size: 10, r2Key }],
  });

  expect(await findMemberAttachmentByHash(db, ana.id, sha256)).toEqual({
    r2Key,
    filename: "logo.png",
    mimeType: "image/png",
  });
  expect(await findMemberAttachmentByHash(db, bo.id, sha256)).toBeNull();
  expect(await findMemberAttachmentByHash(db, ana.id, sha256.slice(1))).toBeNull();
});
