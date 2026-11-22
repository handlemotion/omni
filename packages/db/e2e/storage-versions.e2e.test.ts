import { eq, sql } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { storageContents, storageVersions } from "../src/schema/index.ts";
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

async function addVersion(
  storage: Pick<
    MemberStorage | SharedStorage,
    "openVersionUpload" | "recordUploadPart" | "completeUpload"
  >,
  nodeId: string,
  size: number,
  limitBytes: number | null = null,
  ifContentVersion?: number,
  agent?: string,
) {
  const opened = await storage.openVersionUpload(nodeId, {
    size,
    limitBytes,
    ifContentVersion,
    agent,
  });
  if (opened.status !== "ok") return opened;
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "etag-1", size });
  const done = await storage.completeUpload(opened.upload.id, { limitBytes, ifContentVersion });
  return done.status === "ok" ? { ...done, uploadId: opened.upload.id } : done;
}

const bytesOf = async (orgId: string) => (await storageUsageOf(db, orgId)).bytes;

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

  expect(await recomputeStorageUsage(db, org.id)).toBe(0);
});

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
  const kept = await db
    .select({ size: storageVersions.size, contentVersion: storageVersions.contentVersion })
    .from(storageVersions)
    .where(eq(storageVersions.nodeId, file.id));
  expect(kept).toEqual([{ size: 40, contentVersion: 2 }]);
  expect(await storage.file(file.id)).toMatchObject({ file: { contentVersion: 3 } });
  expect(await storage.restoreVersion(file.id, old!.id)).toEqual({ status: "not_found" });
});

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

  const cutoff = new Date(Date.now() - STORAGE_VERSION_DAYS * DAY_MS);
  expect(await purgeStorageVersions(db, { before: cutoff })).toEqual({ r2Keys: [], more: false });

  await storage.trash(folder.id);
  const deleted = await storage.deleteForever(folder.id);
  if (deleted.status !== "ok") throw new Error(deleted.status);
  expect(new Set(deleted.r2Keys)).toEqual(keys);
  expect(await bytesOf(org.id)).toBe(10);

  const purged = await purgeStorageVersions(db, { before: new Date(Date.now() + DAY_MS) });
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

  const pending = await edits.openVersionUpload(file.id, { size: 2, limitBytes: null });
  if (pending.status !== "ok") throw new Error(pending.status);
  await ana.putGrant(file.id, "editor@outside.test", "viewer");
  expect(await edits.completeUpload(pending.upload.id, { limitBytes: null })).toEqual({
    status: "not_found",
  });
});

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

test("a checked save based on content the file no longer has is refused, on open and on complete", async () => {
  const { org, storage } = await workspace("versions-checked");
  const file = await addFile(storage, { space: "personal" }, "doc.md", 10);
  const based = await storage.file(file.id);
  if (based.status !== "ok") throw new Error(based.status);
  expect(based.file.contentVersion).toBe(1);

  const mine = await storage.openVersionUpload(file.id, {
    size: 7,
    limitBytes: null,
    ifContentVersion: 1,
  });
  if (mine.status !== "ok") throw new Error(mine.status);
  await storage.recordUploadPart(mine.upload.id, { partNumber: 1, etag: "e", size: 7 });
  const theirs = await storage.openVersionUpload(file.id, {
    size: 20,
    limitBytes: null,
    ifContentVersion: 1,
  });
  if (theirs.status !== "ok") throw new Error(theirs.status);
  await storage.recordUploadPart(theirs.upload.id, { partNumber: 1, etag: "e", size: 20 });
  const checked = { limitBytes: null, ifContentVersion: 1 };
  expect(await storage.completeUpload(theirs.upload.id, checked)).toMatchObject({
    status: "ok",
    node: { size: 20, contentVersion: 2 },
  });

  expect(await storage.completeUpload(mine.upload.id, checked)).toEqual({
    status: "version_conflict",
    contentVersion: 2,
  });
  expect(
    await storage.openVersionUpload(file.id, { size: 7, limitBytes: null, ifContentVersion: 1 }),
  ).toEqual({ status: "version_conflict", contentVersion: 2 });
  expect(await storage.file(file.id)).toMatchObject({ file: { size: 20, contentVersion: 2 } });
  expect(await bytesOf(org.id)).toBe(30);

  expect(await addVersion(storage, file.id, 9, null, 2).then((done) => done.status)).toBe("ok");
  expect(await addVersion(storage, file.id, 4).then((done) => done.status)).toBe("ok");
});

const MINUTE_MS = 60_000;

async function listed(storage: MemberStorage, nodeId: string) {
  const versions = await storage.versions(nodeId);
  if (versions.status !== "ok") throw new Error(versions.status);
  return versions;
}

async function age(nodeId: string, ago: { written?: number; sessionStarted?: number }) {
  if (ago.written) {
    await db
      .update(storageContents)
      .set({ writtenAt: sql`now() - ${`${ago.written} milliseconds`}::interval` })
      .where(eq(storageContents.nodeId, nodeId));
  }
  if (ago.sessionStarted) {
    await db
      .update(storageVersions)
      .set({
        replacedAt: sql`${storageVersions.replacedAt} - ${`${ago.sessionStarted} milliseconds`}::interval`,
      })
      .where(eq(storageVersions.nodeId, nodeId));
  }
}

const rowsOf = async (nodeId: string) =>
  (
    await db
      .select({ size: storageVersions.size })
      .from(storageVersions)
      .where(eq(storageVersions.nodeId, nodeId))
  )
    .map((row) => row.size)
    .sort();

test("a member's saves minutes apart are one session: one version, its autosaves purged a day later", async () => {
  const { org, storage } = await workspace("versions-session");
  const file = await addFile(storage, { space: "personal" }, "essay.md", 10);
  for (const size of [11, 12, 13]) {
    expect(await addVersion(storage, file.id, size)).toMatchObject({ status: "ok" });
  }

  const versions = await listed(storage, file.id);
  expect(versions.current).toMatchObject({ size: 13, writtenByAgent: null, contentVersion: 4 });
  expect(versions.versions.map((v) => v.size)).toEqual([10]);
  expect(await bytesOf(org.id)).toBe(46);

  expect(await rowsOf(file.id)).toEqual([10, 11, 12]);
  await purgeStorageVersions(db, {
    before: new Date(Date.now() - STORAGE_VERSION_DAYS * DAY_MS),
    supersededBefore: new Date(Date.now() - DAY_MS),
  });
  expect(await rowsOf(file.id)).toEqual([10, 11, 12]);
  const purged = await purgeStorageVersions(db, {
    before: new Date(Date.now() - STORAGE_VERSION_DAYS * DAY_MS),
    supersededBefore: new Date(Date.now() + MINUTE_MS),
  });
  expect(await rowsOf(file.id)).toEqual([10]);
  expect(purged.r2Keys).toEqual(expect.arrayContaining([expect.stringContaining(org.id)]));
  expect(await bytesOf(org.id)).toBe(23);
  expect((await listed(storage, file.id)).versions.map((v) => v.size)).toEqual([10]);
  expect(await recomputeStorageUsage(db, org.id)).toBe(0);
});

test("a session ends after five quiet minutes, after fifteen in all, and at someone else's save", async () => {
  const { org, storage: ana } = await workspace("versions-session-ends");
  const bea = forMember(db, (await createMember(db, org.id, "bea")).id).storage;
  const file = await addFile(ana, { space: "shared" }, "plan.md", 10);
  await addVersion(ana, file.id, 11);
  await addVersion(ana, file.id, 12);
  expect((await listed(ana, file.id)).versions.map((v) => v.size)).toEqual([10]);

  await age(file.id, { written: 6 * MINUTE_MS });
  await addVersion(ana, file.id, 13);
  expect((await listed(ana, file.id)).versions.map((v) => v.size)).toEqual([12, 10]);

  await age(file.id, { sessionStarted: 16 * MINUTE_MS });
  await addVersion(ana, file.id, 14);
  expect((await listed(ana, file.id)).versions.map((v) => v.size)).toEqual([13, 12, 10]);

  await addVersion(bea, file.id, 15);
  await addVersion(bea, file.id, 16);
  const versions = await listed(ana, file.id);
  expect(versions.versions.map((v) => v.size)).toEqual([14, 13, 12, 10]);
  expect(versions.current).toMatchObject({ size: 16, writtenByName: "bea" });
});

test("an agent's edit is a version of its own, named for the agent, between its member's own saves", async () => {
  const { storage } = await workspace("versions-agent");
  const file = await addFile(storage, { space: "personal" }, "brief.md", 10);
  await addVersion(storage, file.id, 11);
  await addVersion(storage, file.id, 12, null, undefined, "Claude");
  await addVersion(storage, file.id, 13, null, undefined, "Claude");
  await addVersion(storage, file.id, 14);
  await addVersion(storage, file.id, 15);

  const versions = await listed(storage, file.id);
  expect(versions.current).toMatchObject({ size: 15, writtenByAgent: null });
  expect(versions.versions.map((v) => [v.size, v.writtenByName, v.writtenByAgent])).toEqual([
    [13, "ana", "Claude"],
    [12, "ana", "Claude"],
    [11, "ana", null],
    [10, "ana", null],
  ]);
});

test("a file an agent creates is named for the agent, and its first content stays its own version", async () => {
  const { storage } = await workspace("versions-agent-created");
  const opened = await storage.openUpload(
    { space: "personal" },
    { name: "Brief", size: 10, limitBytes: null, agent: "Claude" },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "etag-1", size: 10 });
  const done = await storage.completeUpload(opened.upload.id, { limitBytes: null });
  if (done.status !== "ok") throw new Error(done.status);
  expect((await listed(storage, done.node.id)).current).toMatchObject({
    writtenByName: "ana",
    writtenByAgent: "Claude",
  });

  await addVersion(storage, done.node.id, 11);
  await addVersion(storage, done.node.id, 12);
  const versions = await listed(storage, done.node.id);
  expect(versions.versions.map((v) => [v.size, v.writtenByAgent])).toEqual([[10, "Claude"]]);
});

test("a save that changes the file's type ends the session, so the content before it stays a version", async () => {
  const { storage } = await workspace("versions-session-type");
  const file = await addFile(storage, { space: "personal" }, "notes.md", 10);
  const save = async (size: number, mimeType: string) => {
    const opened = await storage.openVersionUpload(file.id, { size, mimeType, limitBytes: null });
    if (opened.status !== "ok") throw new Error(opened.status);
    await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "etag-1", size });
    expect(await storage.completeUpload(opened.upload.id, { limitBytes: null })).toMatchObject({
      status: "ok",
    });
  };
  await save(11, "text/markdown");
  await save(12, "text/markdown");
  await save(13, "text/vnd.omni.doc");

  const versions = await listed(storage, file.id);
  expect(versions.current).toMatchObject({ size: 13, mimeType: "text/vnd.omni.doc" });
  expect(versions.versions.map((v) => [v.size, v.mimeType])).toEqual([
    [12, "text/markdown"],
    [10, null],
  ]);
});

test("an agent ending the session keeps the content before its change, whoever saves next", async () => {
  const { storage } = await workspace("versions-session-ended");
  const file = await addFile(storage, { space: "personal" }, "plan.md", 10);
  await addVersion(storage, file.id, 11);
  await addVersion(storage, file.id, 12);
  expect(await storage.endSession(file.id)).toBe("ok");
  await addVersion(storage, file.id, 13);
  await addVersion(storage, file.id, 14);

  expect((await listed(storage, file.id)).versions.map((v) => v.size)).toEqual([12, 10]);
});
