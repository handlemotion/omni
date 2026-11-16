// Isolation for the member reads and writes that sit beside `forMember` (packages/db/AGENTS.md):
// compose, library, customers, drafts and preferences. Each one checks the member's grant on the
// row's mailbox in the row's org (`grantFor`), so a teammate without the inbox and a member of
// another org holding a forged grant must both find nothing.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createUpload,
  deleteUnsentUpload,
  memberMailbox,
  memberSignatures,
  memberUpload,
  setSignature,
} from "../src/mail/compose.ts";
import {
  createCannedReply,
  deleteCannedReply,
  getCannedReply,
  listCannedReplies,
  templateContext,
  updateCannedReply,
} from "../src/mail/library.ts";
import { customerProfile, searchCustomers } from "../src/mail/customers.ts";
import {
  cancelSend,
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  memberSendByKey,
  saveDraft,
} from "../src/mail/drafts.ts";
import { customers, threads } from "../src/schema/index.ts";
import { createThread, enqueueAction } from "../src/mail/writers.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

// Org A: ana sees support@, bo is in org A without it. Org B: cy holds a forged grant on
// org A's support@ (a buggy or malicious write must not open another org's data).
let ana: string, bo: string, cy: string;
let orgAId: string;
let supportId: string;

beforeAll(async () => {
  const orgA = await createOrg(db, "content-a");
  const orgB = await createOrg(db, "content-b");
  orgAId = orgA.id;
  ana = (await createMember(db, orgA.id, "ana")).id;
  bo = (await createMember(db, orgA.id, "bo")).id;
  cy = (await createMember(db, orgB.id, "cy")).id;
  const support = await createMailbox(db, orgA.id, "support@content-a.test");
  supportId = support.id;
  await grant(db, orgA.id, support.id, ana);
  await grant(db, orgA.id, support.id, cy);
});

describe("compose", () => {
  test("mailboxes, uploads and signatures are visible only through a grant in the row's org", async () => {
    const upload = await createUpload(db, {
      id: crypto.randomUUID(),
      orgId: orgAId,
      mailboxId: supportId,
      memberId: ana,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: 1,
      r2Key: "k",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      await setSignature(db, ana, supportId, "inbox", { bodyText: "Acme", bodyHtml: null }),
    ).toBe(true);

    expect((await memberMailbox(db, ana, supportId))?.id).toBe(supportId);
    expect((await memberUpload(db, ana, upload.id))?.id).toBe(upload.id);
    expect((await memberSignatures(db, ana, supportId))?.inbox?.bodyText).toBe("Acme");

    for (const outsider of [bo, cy]) {
      expect(await memberMailbox(db, outsider, supportId)).toBeNull();
      expect(await memberUpload(db, outsider, upload.id)).toBeNull();
      expect(await memberSignatures(db, outsider, supportId)).toBeNull();
      expect(
        await setSignature(db, outsider, supportId, "inbox", { bodyText: "x", bodyHtml: null }),
      ).toBe(false);
      expect(await deleteUnsentUpload(db, outsider, upload.id)).toBeNull();
    }
    expect((await memberSignatures(db, ana, supportId))?.inbox?.bodyText).toBe("Acme");
    expect(await deleteUnsentUpload(db, ana, upload.id)).toBe("k");
  });
});

describe("canned replies", () => {
  test("an inbox's replies and a member's own are reachable only by those allowed", async () => {
    const fields = { bodyText: "Hi", bodyHtml: null, setStatus: null, addTagIds: [] };
    const shared = await createCannedReply(db, ana, {
      ...fields,
      title: "Refund",
      mailboxId: supportId,
    });
    const own = await createCannedReply(db, ana, { ...fields, title: "Mine", mailboxId: null });
    if (!shared.reply || !own.reply) throw new Error("create failed");
    const ids = [shared.reply.id, own.reply.id];
    const threadId = await createThread(db, {
      orgId: orgAId,
      mailboxId: supportId,
      subjectKey: "refund",
      lastMessageAt: new Date(),
    });

    expect(
      (await listCannedReplies(db, ana, { mailboxId: supportId })).map((r) => r.title),
    ).toEqual(["Mine", "Refund"]);
    expect((await templateContext(db, ana, threadId))?.inboxAddress).toBe("support@content-a.test");

    for (const outsider of [bo, cy]) {
      expect(await listCannedReplies(db, outsider, { mailboxId: supportId })).toEqual([]);
      for (const id of ids) {
        expect(await getCannedReply(db, outsider, id)).toBeNull();
        expect(await updateCannedReply(db, outsider, id, { title: "x" })).toEqual({
          error: "not_found",
        });
        expect(await deleteCannedReply(db, outsider, id)).toBe(false);
      }
      expect(await templateContext(db, outsider, threadId)).toBeNull();
      expect(
        await createCannedReply(db, outsider, { ...fields, title: "x", mailboxId: supportId }),
      ).toEqual({ error: "not_found" });
    }
  });
});

describe("customers", () => {
  test("a customer is found only through a conversation the member can see", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ orgId: orgAId, address: "luis@client.test", name: "Luis" })
      .returning();
    const threadId = await createThread(db, {
      orgId: orgAId,
      mailboxId: supportId,
      subjectKey: "luis",
      lastMessageAt: new Date(),
    });
    await db.update(threads).set({ customerId: customer!.id }).where(eq(threads.id, threadId));

    expect((await searchCustomers(db, ana, "lu")).map((c) => c.id)).toEqual([customer!.id]);
    expect((await customerProfile(db, ana, customer!.id))?.address).toBe("luis@client.test");
    for (const outsider of [bo, cy]) {
      expect(await searchCustomers(db, outsider, "lu")).toEqual([]);
      expect(await customerProfile(db, outsider, customer!.id)).toBeNull();
    }
  });
});

describe("drafts and sends", () => {
  test("a shared draft and a held send are reachable only by those allowed", async () => {
    const draft = await createDraft(db, ana, { mailboxId: supportId, kind: "new", bodyText: "Hi" });
    if (!draft) throw new Error("create failed");
    expect(await createDraft(db, bo, { mailboxId: supportId, kind: "new" })).toBeNull();
    expect(await createDraft(db, cy, { mailboxId: supportId, kind: "new" })).toBeNull();
    const send = await enqueueAction(db, {
      orgId: orgAId,
      mailboxId: supportId,
      memberId: ana,
      idempotencyKey: `content-send-${crypto.randomUUID()}`,
      kind: "send",
      payload: { from: "support@content-a.test", to: ["x@y.test"], subject: "s", text: "t" },
    });

    expect((await listDrafts(db, ana, { mailboxId: supportId })).map((d) => d.id)).toEqual([
      draft.id,
    ]);
    for (const outsider of [bo, cy]) {
      expect(await listDrafts(db, outsider, { mailboxId: supportId })).toEqual([]);
      expect(await getDraft(db, outsider, draft.id)).toBeNull();
      expect(await saveDraft(db, outsider, draft.id, draft.version, { bodyText: "x" })).toBeNull();
      expect(await deleteDraft(db, outsider, draft.id)).toBe(false);
      expect(await memberSendByKey(db, outsider, send.idempotencyKey)).toBeNull();
      expect(await cancelSend(db, outsider, send.id)).toBeNull();
    }
    expect((await getDraft(db, ana, draft.id))?.bodyText).toBe("Hi");
    expect((await memberSendByKey(db, ana, send.idempotencyKey))?.id).toBe(send.id);
  });
});
