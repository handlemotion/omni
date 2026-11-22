import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { storageVersions } from "../src/schema/index.ts";
import { addCoauthors, foldContent, publicStorage, type StorageGuest } from "../src/storage.ts";
import { addFile, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const otter: StorageGuest = { id: "g".repeat(22), name: "Guest Otter" };
const heron: StorageGuest = { id: "h".repeat(22), name: "Guest Heron" };

async function sharedDoc(name: string) {
  const org = await createOrg(db, name);
  const member = await createMember(db, org.id, "ana");
  const ana = forMember(db, member.id).storage;
  const doc = await addFile(ana, { space: "shared" }, "Plan.md");
  const opened = await ana.setLinkAccess(doc.id, "anyone");
  if (opened.status !== "ok" || !opened.sharing.shareId) throw new Error("link");
  return { org, member, ana, doc, shareId: opened.sharing.shareId };
}
test("a link is Viewer until its role is set, and an Editor link still writes nothing over HTTP", async () => {
  const { ana, doc, shareId } = await sharedDoc("roles");
  const link = publicStorage(db, shareId, { guest: otter });
  expect((await link.node())?.role).toBe("viewer");
  const before = await ana.sharing(doc.id);
  expect(before.status === "ok" && before.sharing.link.role).toBe("viewer");

  const set = await ana.setLinkSettings(doc.id, { role: "editor" });
  expect(set.status === "ok" && set.sharing.link.role).toBe("editor");
  expect((await link.node())?.role).toBe("editor");
  expect(Object.keys(link)).not.toEqual(
    expect.arrayContaining(["openUpload", "createFolder", "rename", "move"]),
  );
  expect(Object.keys(link)).not.toContain("openVersionUpload");
});
test("with link editing off, no link becomes Editor and an Editor link opens as Commenter", async () => {
  const { member, ana, doc, shareId } = await sharedDoc("no-link-editing");
  await setRole(db, member.id, "owner");
  expect((await ana.setLinkSettings(doc.id, { role: "editor" })).status).toBe("ok");
  const off = await forMember(db, member.id).storage.setPolicy({ linkEditing: false });
  expect(off.status === "ok" && off.policy.linkEditing).toBe(false);

  expect((await publicStorage(db, shareId).node())?.role).toBe("commenter");
  expect((await ana.setLinkSettings(doc.id, { role: "editor" })).status).toBe("policy");
  expect((await ana.setLinkSettings(doc.id, { role: "commenter" })).status).toBe("ok");
});
test("a guest on a Commenter link comments as themselves, and only they change it", async () => {
  const { ana, doc, shareId } = await sharedDoc("guest-comments");
  const viewer = publicStorage(db, shareId, { guest: otter });
  expect((await viewer.addComment(doc.id, { body: "hi" })).status).toBe("forbidden");

  await ana.setLinkSettings(doc.id, { role: "commenter" });
  const asOtter = publicStorage(db, shareId, { guest: otter });
  const asHeron = publicStorage(db, shareId, { guest: heron });
  const added = await asOtter.addComment(doc.id, { body: "Typo in step two" });
  if (added.status !== "ok") throw new Error(added.status);
  expect(added.comment).toMatchObject({ authorName: "Guest Otter", authorGuest: true, mine: true });
  expect(added.notified.memberIds).toEqual([]);

  const memberComment = await ana.addComment(doc.id, { body: "Thanks" });
  if (memberComment.status !== "ok") throw new Error(memberComment.status);

  const seenByHeron = await asHeron.comments(doc.id);
  expect(seenByHeron.status === "ok" && seenByHeron.comments.map((c) => c.mine)).toEqual([
    false,
    false,
  ]);
  const seenByAna = await ana.comments(doc.id);
  expect(seenByAna.status === "ok" && seenByAna.comments[0]).toMatchObject({
    authorGuest: true,
    mine: false,
  });
  expect((await asHeron.deleteComment(doc.id, added.comment.id)).status).toBe("forbidden");
  expect((await asOtter.deleteComment(doc.id, memberComment.comment.id)).status).toBe("forbidden");
  expect((await asOtter.editComment(doc.id, added.comment.id, "Typo fixed")).status).toBe("ok");
  expect((await asOtter.resolveComment(doc.id, added.comment.id, true)).status).toBe("ok");
});
test("the Worker's save of a guest's typing names the guest, keeps one session, and runs once", async () => {
  const { org, ana, doc } = await sharedDoc("guest-folds");
  const fold = (base: number, writer: { memberId: null; guest: StorageGuest }, key: string) =>
    foldContent(db, {
      orgId: org.id,
      nodeId: doc.id,
      base,
      size: 12,
      mimeType: doc.mimeType,
      r2Key: `orgs/${org.id}/${key}`,
      writer,
      coauthors: [{ kind: "guest", id: writer.guest.id, name: writer.guest.name }],
      limitBytes: null,
    });

  const first = await fold(doc.contentVersion, { memberId: null, guest: otter }, "f1");
  if (first.status !== "ok") throw new Error(first.status);
  expect((await fold(doc.contentVersion, { memberId: null, guest: otter }, "again")).status).toBe(
    "version_conflict",
  );
  const second = await fold(first.node.contentVersion, { memberId: null, guest: otter }, "f2");
  if (second.status !== "ok") throw new Error(second.status);

  const listed = await ana.versions(doc.id);
  if (listed.status !== "ok") throw new Error(listed.status);
  expect(listed.current).toMatchObject({ writtenByName: "Guest Otter", writtenByGuest: true });
  expect(listed.current.coauthors).toEqual([{ kind: "guest", id: otter.id, name: "Guest Otter" }]);
  expect(listed.versions).toHaveLength(1);
  const superseded = await db
    .select({ supersededAt: storageVersions.supersededAt })
    .from(storageVersions)
    .where(eq(storageVersions.nodeId, doc.id));
  expect(superseded.filter((row) => row.supersededAt).length).toBe(1);

  const third = await fold(second.node.contentVersion, { memberId: null, guest: heron }, "f3");
  if (third.status !== "ok") throw new Error(third.status);
  const after = await ana.versions(doc.id);
  if (after.status !== "ok") throw new Error(after.status);
  expect(after.versions[0]).toMatchObject({ writtenByName: "Guest Otter", writtenByGuest: true });
  expect(after.current).toMatchObject({ writtenByName: "Guest Heron" });
});

test("a member's save names the guests whose typing it holds, and an older save's names go nowhere", async () => {
  const { org, ana, doc } = await sharedDoc("member-coauthors");
  const author = (guest: StorageGuest) => ({
    kind: "guest" as const,
    id: guest.id,
    name: guest.name,
  });
  const saved = await foldContent(db, {
    orgId: org.id,
    nodeId: doc.id,
    base: doc.contentVersion,
    size: 12,
    mimeType: doc.mimeType,
    r2Key: `orgs/${org.id}/coauthors`,
    writer: { memberId: null, guest: heron },
    coauthors: [author(heron)],
    limitBytes: null,
  });
  if (saved.status !== "ok") throw new Error(saved.status);
  const now = saved.node.contentVersion;
  await addCoauthors(db, { nodeId: doc.id, contentVersion: now - 1, coauthors: [author(otter)] });
  await addCoauthors(db, { nodeId: doc.id, contentVersion: now, coauthors: [author(otter)] });
  await addCoauthors(db, { nodeId: doc.id, contentVersion: now, coauthors: [author(otter)] });
  const listed = await ana.versions(doc.id);
  expect(listed.status === "ok" && listed.current.coauthors).toEqual([
    author(heron),
    author(otter),
  ]);
});
