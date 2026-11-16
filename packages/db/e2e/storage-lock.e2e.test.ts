// The Storage file lock (ADR 0036 decision 6) at the member door: what a folder holding a locked
// file still allows, and a lock taken inside a caller's transaction.
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { storageLocks, storageNodes } from "../src/schema/index.ts";
import { addFile, addFolder } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

// Catches: a check that looks only at the node itself or its direct children, so a locked file
// two levels down goes to Trash (and, 30 days later, is purged) with its folder; and a lock that
// freezes the whole folder instead of the one file.
test("trashing a folder that holds a locked file two levels down is refused", async () => {
  const org = await createOrg(db, "lock-folder");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const deals = await addFolder(storage, { space: "shared" }, "Deals");
  const acme = await addFolder(storage, { parentId: deals.id }, "Acme");
  const signed = await addFolder(storage, { parentId: acme.id }, "Signed");
  const contract = await addFile(storage, { parentId: signed.id }, "contract.pdf");
  const draft = await addFile(storage, { parentId: signed.id }, "draft.pdf");

  expect(await storage.lock(deals.id)).toEqual({ status: "not_a_file" });
  expect((await storage.lock(contract.id)).status).toBe("ok");

  for (const id of [deals.id, acme.id, signed.id]) {
    expect(await storage.trash(id)).toEqual({ status: "locked" });
  }
  // Taking it out of Shared hides the file from everyone the lock keeps it for.
  expect(await storage.move(deals.id, { space: "personal" })).toEqual({ status: "locked" });
  const live = await db.select().from(storageNodes).where(eq(storageNodes.orgId, org.id));
  expect(live.filter((row) => row.trashedAt !== null)).toEqual([]);

  // Everything else stays an ordinary file or folder.
  expect((await storage.rename(deals.id, "Deals 2026")).status).toBe("ok");
  expect((await storage.move(acme.id, { space: "shared" })).status).toBe("ok");
  expect((await storage.trash(draft.id)).status).toBe("ok");
});

// Catches: the CRM marking a contract signed and locking its file in one transaction, the
// contract write failing, and the file staying locked for a contract that was never signed.
test("a lock taken inside a caller's transaction rolls back with it, and commits with it", async () => {
  const org = await createOrg(db, "lock-tx");
  const ana = await createMember(db, org.id, "ana");
  const file = await addFile(forMember(db, ana.id).storage, { space: "shared" }, "nda.pdf");
  const lockedAt = async () =>
    (await db.select().from(storageLocks).where(eq(storageLocks.nodeId, file.id)))[0]?.lockedAt ??
    null;

  await expect(
    db.transaction(async (tx) => {
      expect((await forMember(tx, ana.id).storage.lock(file.id)).status).toBe("ok");
      throw new Error("the contract write failed");
    }),
  ).rejects.toThrow("the contract write failed");
  expect(await lockedAt()).toBeNull();

  await db.transaction(async (tx) => {
    expect((await forMember(tx, ana.id).storage.lock(file.id)).status).toBe("ok");
  });
  expect(await lockedAt()).toBeInstanceOf(Date);
  expect(await forMember(db, ana.id).storage.trash(file.id)).toEqual({ status: "locked" });
});

// Catches: a rename that reads the file before a signing transaction commits its lock row, so
// the signed contract's file is renamed after all.
test("a rename racing a lock that has not committed yet waits for it and is refused", async () => {
  const org = await createOrg(db, "lock-rename-race");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const file = await addFile(storage, { space: "shared" }, "msa.pdf");

  let renamed: Promise<{ status: string }> | undefined;
  await db.transaction(async (tx) => {
    expect((await forMember(tx, ana.id).storage.lock(file.id)).status).toBe("ok");
    renamed = storage.rename(file.id, "msa-v2.pdf");
    // Give the rename time to read the file and write, as it would without the tree lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(await renamed).toEqual({ status: "locked" });
  const [row] = await db.select().from(storageNodes).where(eq(storageNodes.id, file.id));
  expect(row!.name).toBe("msa.pdf");
});
