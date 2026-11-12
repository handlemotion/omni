// Isolation for the member reads and writes that sit beside `forMember` (packages/db/AGENTS.md):
// compose, library, customers, drafts and preferences. Each one checks the member's grant on the
// row's mailbox in the row's org (`grantFor`), so a teammate without the inbox and a member of
// another org holding a forged grant must both find nothing.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createUpload,
  deleteUnsentUpload,
  memberMailbox,
  memberSignatures,
  memberUpload,
  setSignature,
} from "../src/compose.ts";
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
