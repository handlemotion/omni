import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { storageNodes, storageUploads, storageUsage } from "../src/schema/index.ts";
import {
  expiredStorageUploads,
  purgeStorageTrash,
  recomputeStorageUsage,
  removeStorageUpload,
  STORAGE_TRASH_DAYS,
  storageUsageOf,
} from "../src/storage.ts";
import { lockTree, lockUsage } from "../src/storage/core.ts";
import { addFile, addFolder, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase, untilLockWaiters } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

async function workspace(slug: string) {
  const org = await createOrg(db, slug);
  const member = await createMember(db, org.id, "ana");
  return { org, member, storage: forMember(db, member.id).storage };
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Opens a transaction, runs `take` in it and keeps it open until `release` is called, then rolls
 * it back. Resolves once `take` has run, so the caller knows what it holds is held.
 */
async function hold(take: (tx: typeof db) => Promise<unknown>) {
  const released = Promise.withResolvers<void>();
  const taken = Promise.withResolvers<void>();
  const done = db
    .transaction(async (tx) => {
      await take(tx as unknown as typeof db);
      taken.resolve();
      await released.promise;
      tx.rollback();
    })
    .catch((error: unknown) => {
      taken.reject(error);
    });
  await taken.promise;
  return async () => {
    released.resolve();
    await done;
  };
}

test("completing an upload twice, even at once, makes one file and counts its bytes once", async () => {
  const { org, storage } = await workspace("complete-twice");
  const opened = await storage.openUpload(
    { space: "personal" },
    { name: "video.mp4", size: 300, mimeType: "video/mp4", limitBytes: null },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  const { id } = opened.upload;
  expect(opened.upload.r2Key).toBe(`orgs/${org.id}/${id}`);
  expect(await storage.startUpload(id, "r2-multipart-1")).toMatchObject({
    r2UploadId: "r2-multipart-1",
  });

  // Parts arrive in parallel and out of order, and one is sent again: none is lost or doubled.
  await Promise.all([
    storage.recordUploadPart(id, { partNumber: 3, etag: "c", size: 100 }),
    storage.recordUploadPart(id, { partNumber: 1, etag: "a-first-try", size: 100 }),
    storage.recordUploadPart(id, { partNumber: 2, etag: "b", size: 100 }),
  ]);
  await storage.recordUploadPart(id, { partNumber: 1, etag: "a", size: 100 });
  expect((await storage.upload(id))?.parts).toEqual([
    { partNumber: 1, etag: "a", size: 100 },
    { partNumber: 2, etag: "b", size: 100 },
    { partNumber: 3, etag: "c", size: 100 },
  ]);
  // More bytes than declared would dodge the quota that was checked at open.
  expect((await storage.recordUploadPart(id, { partNumber: 4, etag: "d", size: 1 })).status).toBe(
    "too_large",
  );

  const results = await Promise.all([
    storage.completeUpload(id, { limitBytes: null }),
    storage.completeUpload(id, { limitBytes: null }),
  ]);
  const again = await storage.completeUpload(id, { limitBytes: null });
  for (const result of [...results, again]) {
    expect(result).toMatchObject({ status: "ok", node: { id, name: "video.mp4", size: 300 } });
  }
  expect(results.filter((result) => result.status === "ok" && result.created)).toHaveLength(1);
  expect(await db.select().from(storageNodes).where(eq(storageNodes.orgId, org.id))).toHaveLength(
    1,
  );
  expect(await storageUsageOf(db, org.id)).toEqual({ bytes: 300, reservedBytes: 0 });
  // A finished upload is a file now: aborting it must not drop anything.
  expect((await storage.abortUpload(id)).status).toBe("not_found");
});

test("an upload whose parts do not add up to its declared size cannot complete", async () => {
  const { org, storage } = await workspace("short-upload");
  const opened = await storage.openUpload(
    { space: "personal" },
    { name: "half.bin", size: 200, limitBytes: null },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "a", size: 100 });
  expect((await storage.completeUpload(opened.upload.id, { limitBytes: null })).status).toBe(
    "incomplete",
  );
  expect(await storageUsageOf(db, org.id)).toEqual({ bytes: 0, reservedBytes: 200 });
});

test("an open that would pass the limit is refused, and concurrent opens cannot both take the last room", async () => {
  const { org, storage } = await workspace("quota");
  await addFile(storage, { space: "personal" }, "existing.bin", 600);
  const file = (size: number) => ({ name: "next.bin", size, limitBytes: 1000 });

  expect(await storage.openUpload({ space: "personal" }, file(401))).toEqual({
    status: "full",
    usedBytes: 600,
    reservedBytes: 0,
    limitBytes: 1000,
  });
  // A refused open leaves nothing behind that would hold room.
  expect(await storageUsageOf(db, org.id)).toEqual({ bytes: 600, reservedBytes: 0 });

  // Six uploads of 300 race for 400 free bytes: exactly one fits.
  const raced = await Promise.all(
    Array.from({ length: 6 }, () => storage.openUpload({ space: "personal" }, file(300))),
  );
  const won = raced.filter((result) => result.status === "ok");
  expect(won).toHaveLength(1);
  expect(raced.filter((result) => result.status === "full")).toHaveLength(5);
  // The winner's declared bytes are held before a single byte arrives.
  expect((await storage.usage())?.reservedBytes).toBe(300);
  expect((await storage.openUpload({ space: "personal" }, file(101))).status).toBe("full");

  // Aborting gives the room back; trashing a file does not, until it is purged.
  const winner = won[0]!;
  if (winner.status !== "ok") throw new Error(winner.status);
  expect((await storage.abortUpload(winner.upload.id)).status).toBe("ok");
  const [existing] = await db.select().from(storageNodes).where(eq(storageNodes.orgId, org.id));
  await storage.trash(existing!.id);
  expect((await storage.openUpload({ space: "personal" }, file(401))).status).toBe("full");
  expect((await storage.openUpload({ space: "personal" }, file(400))).status).toBe("ok");
});

test("completing re-checks the limit, so a lowered allowance stores nothing", async () => {
  const { org, storage } = await workspace("quota-complete");
  const opened = await storage.openUpload(
    { space: "personal" },
    { name: "a.bin", size: 500, limitBytes: 1000 },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "a", size: 500 });
  expect(await storage.completeUpload(opened.upload.id, { limitBytes: 400 })).toMatchObject({
    status: "full",
    limitBytes: 400,
  });
  expect(await db.select().from(storageNodes).where(eq(storageNodes.orgId, org.id))).toEqual([]);
  expect((await storageUsageOf(db, org.id)).bytes).toBe(0);
});

test("purging Trash frees the bytes of everything inside, only once it is 30 days old", async () => {
  const { org, member, storage } = await workspace("purge");
  const folder = await addFolder(storage, { space: "personal" }, "Old");
  const inner = await addFolder(storage, { parentId: folder.id }, "Inner");
  const one = await addFile(storage, { parentId: folder.id }, "one.bin", 100);
  const two = await addFile(storage, { parentId: inner.id }, "two.bin", 50);
  const kept = await addFile(storage, { space: "personal" }, "kept.bin", 7);
  const recent = await addFile(storage, { space: "personal" }, "recent.bin", 3);
  await storage.trash(folder.id);
  await storage.trash(recent.id);
  const cutoff = (now: number) => new Date(now - STORAGE_TRASH_DAYS * DAY_MS);

  expect(await purgeStorageTrash(db, { before: cutoff(Date.now()) })).toEqual({
    r2Keys: [],
    more: false,
  });
  expect((await storageUsageOf(db, org.id)).bytes).toBe(160);

  // 31 days on for the folder; the file trashed "today" stays.
  await db
    .update(storageNodes)
    .set({ trashedAt: new Date(Date.now() - 31 * DAY_MS) })
    .where(eq(storageNodes.id, folder.id));
  const purged = await purgeStorageTrash(db, { before: cutoff(Date.now()) });
  expect(purged.r2Keys.toSorted()).toEqual(
    [`orgs/${org.id}/${one.id}`, `orgs/${org.id}/${two.id}`].toSorted(),
  );
  expect((await storageUsageOf(db, org.id)).bytes).toBe(10);
  expect(
    (await db.select().from(storageNodes).where(eq(storageNodes.orgId, org.id)))
      .map((node) => node.id)
      .toSorted(),
  ).toEqual([kept.id, recent.id].toSorted());
  // Run again, as a retried cron would: nothing more goes.
  expect((await purgeStorageTrash(db, { before: cutoff(Date.now()) })).r2Keys).toEqual([]);

  // Delete forever does the same at once, and only from Trash.
  expect((await storage.deleteForever(kept.id)).status).toBe("not_trashed");
  expect(await storage.deleteForever(recent.id)).toEqual({
    status: "ok",
    r2Keys: [`orgs/${org.id}/${recent.id}`],
    drive: { orgId: org.id, space: "personal", ownerMemberId: member.id },
  });
  expect((await storageUsageOf(db, org.id)).bytes).toBe(7);
});

test("recompute repairs a drifted usage counter and leaves a right one alone", async () => {
  const { org, storage } = await workspace("drift");
  const other = await workspace("drift-other");
  await addFile(storage, { space: "personal" }, "a.bin", 40);
  const trashed = await addFile(storage, { space: "personal" }, "b.bin", 2);
  await storage.trash(trashed.id);
  await addFile(other.storage, { space: "personal" }, "c.bin", 5);
  await db.update(storageUsage).set({ bytes: 999_999 }).where(eq(storageUsage.orgId, org.id));

  expect(await recomputeStorageUsage(db)).toBe(1);
  // Trashed files still count until they are purged.
  expect((await storageUsageOf(db, org.id)).bytes).toBe(42);
  expect((await storageUsageOf(db, other.org.id)).bytes).toBe(5);
  expect(await recomputeStorageUsage(db)).toBe(0);
});

test("an expired upload is handed to the cron once, cannot complete, and stops holding room", async () => {
  const { org, storage } = await workspace("expired");
  const done = await addFile(storage, { space: "personal" }, "done.bin", 10);
  const opened = await storage.openUpload(
    { space: "personal" },
    { name: "abandoned.bin", size: 500, limitBytes: null },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  await storage.startUpload(opened.upload.id, "r2-multipart-9");
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "a", size: 500 });
  expect(await expiredStorageUploads(db)).toEqual([]);

  await db
    .update(storageUploads)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(storageUploads.orgId, org.id));
  expect((await storage.completeUpload(opened.upload.id, { limitBytes: null })).status).toBe(
    "not_found",
  );
  expect((await storageUsageOf(db, org.id)).reservedBytes).toBe(0);
  expect(await expiredStorageUploads(db)).toEqual([
    {
      id: opened.upload.id,
      orgId: org.id,
      r2Key: `orgs/${org.id}/${opened.upload.id}`,
      r2UploadId: "r2-multipart-9",
    },
  ]);
  await removeStorageUpload(db, opened.upload.id);
  expect(await expiredStorageUploads(db)).toEqual([]);
  // The completed upload's row was forgotten with it; its file is untouched.
  expect(await db.select().from(storageUploads).where(eq(storageUploads.orgId, org.id))).toEqual(
    [],
  );
  expect((await storage.file(done.id)).status).toBe("ok");
});

test("completing an upload again answers not_found once the file has left what the uploader reaches", async () => {
  const org = await createOrg(db, "complete-after-move");
  const ana = await createMember(db, org.id, "ana");
  const admin = await createMember(db, org.id, "admin");
  await setRole(db, admin.id, "admin");
  const anaStorage = forMember(db, ana.id).storage;
  const opened = await anaStorage.openUpload(
    { space: "shared" },
    { name: "plan.pdf", size: 10, limitBytes: null },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  const { id } = opened.upload;
  await anaStorage.recordUploadPart(id, { partNumber: 1, etag: "a", size: 10 });
  expect((await anaStorage.completeUpload(id, { limitBytes: null })).status).toBe("ok");

  // The admin takes the file into their own My files and renames it there.
  const adminStorage = forMember(db, admin.id).storage;
  expect((await adminStorage.move(id, { space: "personal" })).status).toBe("ok");
  expect((await adminStorage.rename(id, "private.pdf")).status).toBe("ok");

  expect(await anaStorage.node(id)).toBeNull();
  expect(await anaStorage.completeUpload(id, { limitBytes: null })).toEqual({
    status: "not_found",
  });
});

test("an upload completing while its folder moves to another drive lands in the folder's drive", async () => {
  const { org, member, storage } = await workspace("complete-during-move");
  const folder = await addFolder(storage, { space: "shared" }, "Plans");
  const opened = await storage.openUpload(
    { parentId: folder.id },
    { name: "a.bin", size: 10, limitBytes: null },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  const { id } = opened.upload;
  await storage.recordUploadPart(id, { partNumber: 1, etag: "a", size: 10 });

  // An uncommitted sibling of the same name makes the completing insert wait on the unique
  // index, after it has looked the folder up: the window a move has to land in.
  const release = await hold((tx) =>
    tx.insert(storageNodes).values({
      orgId: org.id,
      space: "shared",
      parentId: folder.id,
      kind: "folder",
      name: "a.bin",
    }),
  );
  const completing = storage.completeUpload(id, { limitBytes: null });
  await untilLockWaiters(db, 1);
  let moved = false;
  const moving = storage.move(folder.id, { space: "personal" }).finally(() => {
    moved = true;
  });
  // The move either lands now, or waits its turn behind the completing upload.
  await untilLockWaiters(db, 2, () => moved);
  await release();

  expect((await completing).status).toBe("ok");
  expect((await moving).status).toBe("ok");
  const drive = { space: "personal", ownerMemberId: member.id };
  const rows = await db.select().from(storageNodes).where(eq(storageNodes.orgId, org.id));
  expect(rows.find((row) => row.id === folder.id)).toMatchObject(drive);
  expect(rows.find((row) => row.id === id)).toMatchObject({ ...drive, parentId: folder.id });
});

test("a node restored and trashed again while a purge runs keeps its fresh 30 days", async () => {
  const { org, storage } = await workspace("purge-retrashed");
  const file = await addFile(storage, { space: "personal" }, "old.bin", 25);
  await storage.trash(file.id);
  await db
    .update(storageNodes)
    .set({ trashedAt: new Date(Date.now() - 31 * DAY_MS) })
    .where(eq(storageNodes.id, file.id));

  // The purge has picked the node and waits for the workspace's tree.
  const release = await hold((tx) => lockTree(tx, org.id));
  const purging = purgeStorageTrash(db, {
    before: new Date(Date.now() - STORAGE_TRASH_DAYS * DAY_MS),
  });
  await untilLockWaiters(db, 1);
  // Restored and trashed again meanwhile: what a restore and a trash leave behind, written
  // directly because a restore now queues on the same lock.
  await db.update(storageNodes).set({ trashedAt: new Date() }).where(eq(storageNodes.id, file.id));
  await release();

  expect(await purging).toEqual({ r2Keys: [], more: false });
  expect((await storage.listTrash()).nodes.map((node) => node.id)).toEqual([file.id]);
  expect((await storageUsageOf(db, org.id)).bytes).toBe(25);
});

test("a restore racing a permanent delete cannot report success for a file that is then deleted", async () => {
  const { org, storage } = await workspace("restore-vs-delete");
  const file = await addFile(storage, { space: "personal" }, "keep.bin", 25);
  await storage.trash(file.id);

  // The delete has seen the node in Trash and waits for the usage row.
  const release = await hold((tx) => lockUsage(tx, org.id));
  const deleting = storage.deleteForever(file.id);
  await untilLockWaiters(db, 1);
  let restored = false;
  const restoring = storage.restore(file.id).finally(() => {
    restored = true;
  });
  // The restore either lands now (the bug), or waits its turn behind the delete.
  await untilLockWaiters(db, 2, () => restored);
  await release();

  expect((await deleting).status).toBe("ok");
  expect((await restoring).status).toBe("not_found");
});
