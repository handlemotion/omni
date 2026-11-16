// File versions (ADR 0043 decision 1) on real Postgres: a new version keeps what it replaces,
// the bytes are counted while they are kept, and everything that deletes a file takes its
// versions' objects with it.
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { storageVersions } from "../src/schema/index.ts";
import {
  purgeStorageVersions,
  recomputeStorageUsage,
  STORAGE_VERSION_DAYS,
  storageUsageOf,
  type MemberStorage,
  type SharedStorage,
} from "../src/storage.ts";
import { addFile, addFolder, createPerson } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const DAY_MS = 24 * 60 * 60_000;

async function workspace(slug: string) {
  const org = await createOrg(db, slug);
  const member = await createMember(db, org.id, "ana");
  return { org, member, storage: forMember(db, member.id).storage };
}

/** Uploads `size` bytes as a new version of the file, the way the Worker does. */
async function addVersion(
  storage: Pick<
    MemberStorage | SharedStorage,
    "openVersionUpload" | "recordUploadPart" | "completeUpload"
  >,
  nodeId: string,
  size: number,
  limitBytes: number | null = null,
) {
  const opened = await storage.openVersionUpload(nodeId, { size, limitBytes });
  if (opened.status !== "ok") return opened;
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "etag-1", size });
  const done = await storage.completeUpload(opened.upload.id, { limitBytes });
  return done.status === "ok" ? { ...done, uploadId: opened.upload.id } : done;
}

const bytesOf = async (orgId: string) => (await storageUsageOf(db, orgId)).bytes;

// Catches: a new version that overwrites the old content's key (nothing to restore), usage that
// forgets the kept bytes (free storage by re-uploading), and a second `complete` counting twice.
test("a new version keeps the old content, counts both, and completing twice counts once", async () => {
  const { org, storage } = await workspace("versions-keep");
  const file = await addFile(storage, { space: "personal" }, "plan.md", 10);
  const original = await storage.file(file.id);
  if (original.status !== "ok") throw new Error(original.status);

  const second = await addVersion(storage, file.id, 25);
  if (second.status !== "ok") throw new Error(second.status);
  expect(second.node).toMatchObject({ id: file.id, name: "plan.md", size: 25 });
  const again = await storage.completeUpload(second.uploadId, { limitBytes: null });
  expect(again).toMatchObject({ status: "ok", created: false, node: { id: file.id, size: 25 } });
  expect(await bytesOf(org.id)).toBe(35);

  const now = await storage.file(file.id);
  if (now.status !== "ok") throw new Error(now.status);
  expect(now.r2Key).toBe(second.r2Key);
  expect(now.r2Key).not.toBe(original.r2Key);

  const listed = await storage.versions(file.id);
  if (listed.status !== "ok") throw new Error(listed.status);
  expect(listed.current).toMatchObject({ size: 25, writtenByName: "ana" });
  expect(listed.versions).toHaveLength(1);
  expect(listed.versions[0]).toMatchObject({ size: 10, writtenByName: "ana" });
  expect(listed.versions[0]!.writtenAt).toEqual(file.createdAt);
  const kept = await storage.versionFile(file.id, listed.versions[0]!.id);
  expect(kept).toMatchObject({ status: "ok", r2Key: original.r2Key, file: { size: 10 } });

  // The recount agrees with the counter: versions are part of what a workspace stores.
  expect(await recomputeStorageUsage(db, org.id)).toBe(0);
});

// Catches: a restore that copies instead of swapping (bytes counted twice), or that loses the
// content it displaces.
test("restoring a version swaps it with the current content and stores no more bytes", async () => {
  const { org, storage } = await workspace("versions-restore");
  const file = await addFile(storage, { space: "personal" }, "notes.txt", 10);
  const first = await storage.file(file.id);
  const second = await addVersion(storage, file.id, 40);
  if (first.status !== "ok" || second.status !== "ok") throw new Error("seed");
  const [old] = ((await storage.versions(file.id)) as { versions: { id: string }[] }).versions;

  const restored = await storage.restoreVersion(file.id, old!.id);
  expect(restored).toMatchObject({ status: "ok", node: { id: file.id, size: 10 } });
  expect(await storage.file(file.id)).toMatchObject({ r2Key: first.r2Key });
  const after = await storage.versions(file.id);
  if (after.status !== "ok") throw new Error(after.status);
  expect(after.current.writtenAt).toEqual(file.createdAt);
  expect(after.versions.map((version) => version.size)).toEqual([40]);
  expect(await storage.versionFile(file.id, after.versions[0]!.id)).toMatchObject({
    r2Key: second.r2Key,
  });
  expect(await bytesOf(org.id)).toBe(50);
  // The same version cannot be restored twice: it is the current content now.
  expect(await storage.restoreVersion(file.id, old!.id)).toEqual({ status: "not_found" });
});

// Catches: a signed contract whose bytes change under its lock, by upload or by restore, and an
// upload opened before the lock that completes after it.
test("a locked file takes no new version and no restore", async () => {
  const { org, storage } = await workspace("versions-locked");
  const file = await addFile(storage, { space: "shared" }, "contract.pdf", 10);
  await addVersion(storage, file.id, 20);
  const pending = await storage.openVersionUpload(file.id, { size: 5, limitBytes: null });
  if (pending.status !== "ok") throw new Error(pending.status);
  await storage.recordUploadPart(pending.upload.id, { partNumber: 1, etag: "e", size: 5 });
  expect((await storage.lock(file.id)).status).toBe("ok");

  expect(await addVersion(storage, file.id, 30)).toEqual({ status: "locked" });
  expect(await storage.completeUpload(pending.upload.id, { limitBytes: null })).toEqual({
    status: "locked",
  });
  const listed = await storage.versions(file.id);
  if (listed.status !== "ok") throw new Error(listed.status);
  expect(await storage.restoreVersion(file.id, listed.versions[0]!.id)).toEqual({
    status: "locked",
  });
  expect(await storage.file(file.id)).toMatchObject({ file: { size: 20 } });
  expect(await bytesOf(org.id)).toBe(30);
});

// Catches: objects left in the bucket for ever (a delete that returns only the node's key), and
// a usage counter that keeps charging for versions that are gone.
test("deleting a file for good, and the 30-day purge, free its versions' bytes and name their objects", async () => {
  const { org, storage } = await workspace("versions-delete");
  const folder = await addFolder(storage, { space: "personal" }, "Docs");
  const file = await addFile(storage, { parentId: folder.id }, "a.md", 10);
  const other = await addFile(storage, { space: "personal" }, "b.md", 7);
  const keys = new Set<string>();
  for (const size of [20, 30]) {
    const before = await storage.file(file.id);
    if (before.status === "ok") keys.add(before.r2Key);
    await addVersion(storage, file.id, size);
  }
  const current = await storage.file(file.id);
  if (current.status !== "ok") throw new Error(current.status);
  keys.add(current.r2Key);
  const otherFirst = await storage.file(other.id);
  if (otherFirst.status !== "ok") throw new Error(otherFirst.status);
  await addVersion(storage, other.id, 3);
  expect(await bytesOf(org.id)).toBe(70);

  // Not yet due: a version is kept 30 days from when it was replaced.
  const cutoff = new Date(Date.now() - STORAGE_VERSION_DAYS * DAY_MS);
  expect(await purgeStorageVersions(db, { before: cutoff })).toEqual({ r2Keys: [], more: false });

  await storage.trash(folder.id);
  const deleted = await storage.deleteForever(folder.id);
  if (deleted.status !== "ok") throw new Error(deleted.status);
  expect(new Set(deleted.r2Keys)).toEqual(keys);
  expect(await bytesOf(org.id)).toBe(10);

  const purged = await purgeStorageVersions(db, { before: new Date(Date.now() + DAY_MS) });
  // The purge is every workspace's: other tests' versions are due by then too.
  expect(purged.r2Keys).toContain(otherFirst.r2Key);
  const live = await storage.file(other.id);
  expect(purged.r2Keys).not.toContain(live.status === "ok" && live.r2Key);
  expect(await bytesOf(org.id)).toBe(3);
  expect(await db.select().from(storageVersions).where(eq(storageVersions.orgId, org.id))).toEqual(
    [],
  );
  expect(await storage.file(other.id)).toMatchObject({ file: { size: 3 } });
  expect(await recomputeStorageUsage(db, org.id)).toBe(0);
});

// Catches: a viewer reading what an editor took back, a viewer overwriting a file, an editor
// given one file being unable to edit it, and a colleague reaching another's My files.
test("only someone who may edit a file writes a version or sees the old ones", async () => {
  const { org, storage: ana } = await workspace("versions-access");
  const bea = forMember(db, (await createMember(db, org.id, "bea")).id).storage;
  const file = await addFile(ana, { space: "personal" }, "draft.md", 10);
  await addVersion(ana, file.id, 12);
  const [version] = ((await ana.versions(file.id)) as { versions: { id: string }[] }).versions;

  expect(await bea.versions(file.id)).toEqual({ status: "not_found" });
  expect(await addVersion(bea, file.id, 1)).toEqual({ status: "not_found" });

  const viewer = await createPerson(db, "viewer@outside.test");
  const editor = await createPerson(db, "editor@outside.test");
  await ensurePersonalSpace(db, viewer.id);
  await ensurePersonalSpace(db, editor.id);
  const asViewer = await ana.putGrant(file.id, "viewer@outside.test", "viewer");
  const asEditor = await ana.putGrant(file.id, "editor@outside.test", "editor");
  if (asViewer.status !== "ok" || asEditor.status !== "ok") throw new Error("grant");
  const reads = forUser(db, viewer.id).storage.under(asViewer.shareId);
  const edits = forUser(db, editor.id).storage.under(asEditor.shareId);

  expect((await reads.file(file.id)).status).toBe("ok");
  expect(await reads.versions(file.id)).toEqual({ status: "forbidden" });
  expect(await reads.versionFile(file.id, version!.id)).toEqual({ status: "not_found" });
  expect(await reads.restoreVersion(file.id, version!.id)).toEqual({ status: "forbidden" });
  expect(await addVersion(reads, file.id, 1)).toEqual({ status: "forbidden" });

  expect(await addVersion(edits, file.id, 14)).toMatchObject({ status: "ok", node: { size: 14 } });
  expect(await edits.versions(file.id)).toMatchObject({ versions: [{ size: 12 }, { size: 10 }] });

  // An editor made a viewer while their upload is on its way no longer completes it.
  const pending = await edits.openVersionUpload(file.id, { size: 2, limitBytes: null });
  if (pending.status !== "ok") throw new Error(pending.status);
  await ana.putGrant(file.id, "editor@outside.test", "viewer");
  expect(await edits.completeUpload(pending.upload.id, { limitBytes: null })).toEqual({
    status: "not_found",
  });
});

// Catches: versions as a way past the quota, since the replaced bytes stay stored.
test("a new version must fit the allowance on top of what it replaces", async () => {
  const { org, storage } = await workspace("versions-full");
  const file = await addFile(storage, { space: "personal" }, "big.bin", 60);
  expect(await addVersion(storage, file.id, 50, 100)).toMatchObject({
    status: "full",
    usedBytes: 60,
    limitBytes: 100,
  });
  expect(await addVersion(storage, file.id, 40, 100)).toMatchObject({ status: "ok" });
  expect(await bytesOf(org.id)).toBe(100);
});

// Catches: a version upload whose file was deleted for good meanwhile completing as a brand-new
// file, bringing back what was deleted under another id.
test("a new version of a file deleted for good is refused, not made a new file", async () => {
  const { org, storage } = await workspace("versions-target-gone");
  const file = await addFile(storage, { space: "personal" }, "gone.md", 10);
  const opened = await storage.openVersionUpload(file.id, { size: 5, limitBytes: null });
  if (opened.status !== "ok") throw new Error(opened.status);
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "e", size: 5 });
  await storage.trash(file.id);
  expect((await storage.deleteForever(file.id)).status).toBe("ok");

  expect(await storage.completeUpload(opened.upload.id, { limitBytes: null })).toEqual({
    status: "not_found",
  });
  expect(await storage.file(opened.upload.id)).toEqual({ status: "not_found" });
  expect(await bytesOf(org.id)).toBe(0);
});
