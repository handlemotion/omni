import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { storageTombstones } from "../src/schema/index.ts";
import {
  STORAGE_TOMBSTONE_DAYS,
  sweepStorageTombstones,
  type MemberStorage,
  type StorageChange,
  type StorageSyncCursor,
} from "../src/storage.ts";
import { addFile, addFolder, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

async function drain(
  storage: MemberStorage,
  space: "personal" | "shared",
  cursor: StorageSyncCursor | null = null,
  limit = 2,
) {
  const changes: StorageChange[] = [];
  for (let page = 0; page < 100; page++) {
    const result = await storage.changes(space, { cursor, limit });
    if (result.status !== "ok") throw new Error(`changes: ${result.status}`);
    changes.push(...result.changes);
    cursor = result.nextCursor;
    if (!result.more) return { changes, cursor };
  }
  throw new Error("the feed never ended");
}

const summary = (changes: StorageChange[]) =>
  changes.map((change) =>
    change.deleted
      ? { id: change.id, deleted: true }
      : { id: change.id, name: change.node.name, inTrash: change.inTrash },
  );

test("every write appears once, in order, and a cursor sees only what came after it", async () => {
  const org = await createOrg(db, "sync-feed");
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  const storage = forMember(db, ana.id).storage;
  const docs = await addFolder(storage, { space: "shared" }, "Docs");
  const a = await addFile(storage, { parentId: docs.id }, "a.txt");
  const b = await addFile(storage, { parentId: docs.id }, "b.txt");
  const c = await addFile(storage, { space: "shared" }, "c.txt");

  const first = await drain(storage, "shared");
  expect(summary(first.changes)).toEqual([
    { id: docs.id, name: "Docs", inTrash: false },
    { id: a.id, name: "a.txt", inTrash: false },
    { id: b.id, name: "b.txt", inTrash: false },
    { id: c.id, name: "c.txt", inTrash: false },
  ]);
  const revisions = first.changes.map((change) => change.revision);
  expect(revisions).toEqual(revisions.toSorted((x, y) => x - y));

  const idle = await drain(storage, "shared", first.cursor);
  expect(idle.changes).toEqual([]);

  expect((await storage.rename(c.id, "c2.txt")).status).toBe("ok");
  expect((await storage.lock(a.id)).status).toBe("ok");
  expect((await storage.unlock(a.id)).status).toBe("ok");
  expect((await storage.trash(docs.id)).status).toBe("ok");
  const second = await drain(storage, "shared", idle.cursor);
  expect(summary(second.changes)).toEqual([
    { id: c.id, name: "c2.txt", inTrash: false },
    ...[docs, a, b]
      .map((node) => ({ id: node.id, name: node.name, inTrash: true }))
      .toSorted((x, y) => (x.id < y.id ? -1 : 1)),
  ]);

  expect((await storage.restore(docs.id)).status).toBe("ok");
  const third = await drain(storage, "shared", second.cursor);
  expect(
    summary(third.changes).map((entry) => [entry.id, "inTrash" in entry && entry.inTrash]),
  ).toEqual(
    [docs, a, b].map((node) => [node.id, false]).toSorted((x, y) => (x[0]! < y[0]! ? -1 : 1)),
  );
});

test("a reader never moves past a change still being written", async () => {
  const org = await createOrg(db, "sync-writers");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const file = await addFile(storage, { space: "personal" }, "draft.txt");
  const start = await drain(storage, "personal");

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let renamed!: () => void;
  const inside = new Promise<void>((resolve) => (renamed = resolve));
  const writer = db.transaction(async (tx) => {
    expect((await forMember(tx, ana.id).storage.rename(file.id, "final.txt")).status).toBe("ok");
    renamed();
    await held;
  });
  await inside;
  const during = await drain(storage, "personal", start.cursor);
  expect(during.changes).toEqual([]);
  release();
  await writer;
  const after = await drain(storage, "personal", during.cursor);
  expect(summary(after.changes)).toEqual([{ id: file.id, name: "final.txt", inTrash: false }]);
});

test("a node that leaves a drive leaves a tombstone there, and only there", async () => {
  const org = await createOrg(db, "sync-tombstones");
  const ana = await createMember(db, org.id, "ana");
  const bo = await createMember(db, org.id, "bo");
  const storage = forMember(db, ana.id).storage;
  const mine = await addFile(storage, { space: "personal" }, "mine.txt");
  const moving = await addFolder(storage, { space: "personal" }, "Project");
  const inside = await addFile(storage, { parentId: moving.id }, "plan.txt");
  const gone = await addFile(storage, { space: "personal" }, "gone.txt");
  await addFile(forMember(db, bo.id).storage, { space: "personal" }, "bo-private.txt");
  const start = await drain(storage, "personal");
  expect(start.changes.map((change) => change.id).toSorted()).toEqual(
    [mine.id, moving.id, inside.id, gone.id].toSorted(),
  );
  const sharedStart = await drain(storage, "shared");

  expect((await storage.move(moving.id, { space: "shared" })).status).toBe("ok");
  expect((await storage.trash(gone.id)).status).toBe("ok");
  expect((await storage.deleteForever(gone.id)).status).toBe("ok");

  const personal = await drain(storage, "personal", start.cursor);
  expect(summary(personal.changes).toSorted((x, y) => (x.id < y.id ? -1 : 1))).toEqual(
    [moving.id, inside.id, gone.id].toSorted().map((id) => ({ id, deleted: true })),
  );
  const shared = await drain(storage, "shared", sharedStart.cursor);
  expect(
    summary(shared.changes)
      .map((entry) => entry.id)
      .toSorted(),
  ).toEqual([moving.id, inside.id].toSorted());
  const bos = await drain(forMember(db, bo.id).storage, "personal");
  expect(summary(bos.changes).map((entry) => "name" in entry && entry.name)).toEqual([
    "bo-private.txt",
  ]);
});

test("a cursor behind swept tombstones expires; one past them does not", async () => {
  const org = await createOrg(db, "sync-sweep");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const file = await addFile(storage, { space: "personal" }, "old.txt");
  const behind = await drain(storage, "personal");
  expect((await storage.trash(file.id)).status).toBe("ok");
  expect((await storage.deleteForever(file.id)).status).toBe("ok");
  const past = await drain(storage, "personal", behind.cursor);
  expect(summary(past.changes)).toEqual([{ id: file.id, deleted: true }]);

  const old = new Date(Date.now() - (STORAGE_TOMBSTONE_DAYS + 1) * 86_400_000);
  await db
    .update(storageTombstones)
    .set({ createdAt: old })
    .where(eq(storageTombstones.orgId, org.id));
  const swept = await sweepStorageTombstones(db, { before: new Date(Date.now() - 86_400_000) });
  expect(swept.deleted).toBeGreaterThanOrEqual(1);

  expect(await storage.changes("personal", { cursor: behind.cursor })).toEqual({
    status: "cursor_expired",
  });
  expect((await storage.changes("personal", { cursor: past.cursor })).status).toBe("ok");
  expect((await storage.changes("personal", {})).status).toBe("ok");
});

test("rename, move and trash with a stale revision change nothing", async () => {
  const org = await createOrg(db, "sync-guard");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const folder = await addFolder(storage, { space: "personal" }, "Archive");
  const file = await addFile(storage, { space: "personal" }, "notes.md");
  const read = file.revision;
  expect((await storage.rename(file.id, "notes-2.md")).status).toBe("ok");

  const stale = { ifRevision: read };
  expect(await storage.rename(file.id, "mine.md", stale)).toEqual({ status: "version_conflict" });
  expect(await storage.move(file.id, { parentId: folder.id }, stale)).toEqual({
    status: "version_conflict",
  });
  expect(await storage.trash(file.id, stale)).toEqual({ status: "version_conflict" });
  const now = await storage.node(file.id);
  expect(now?.node).toMatchObject({ name: "notes-2.md", parentId: null, trashedAt: null });

  const fresh = { ifRevision: now!.node.revision };
  const moved = await storage.move(file.id, { parentId: folder.id }, fresh);
  if (moved.status !== "ok") throw new Error(moved.status);
  expect(moved.node.revision).toBeGreaterThan(fresh.ifRevision);
  expect((await storage.trash(file.id, { ifRevision: moved.node.revision })).status).toBe("ok");
});

test("a file keeps the SHA-256 its uploader sent", async () => {
  const org = await createOrg(db, "sync-sha");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const sha256 = "ab".repeat(32);
  const opened = await storage.openUpload(
    { space: "personal" },
    { name: "a.bin", size: 4, limitBytes: null, sha256 },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "e", size: 4 });
  const done = await storage.completeUpload(opened.upload.id, { limitBytes: null });
  if (done.status !== "ok") throw new Error(done.status);
  expect(done.node).toMatchObject({ contentSha256: sha256, contentVersion: 1 });
});
