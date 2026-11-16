import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { members, storageNodes } from "../src/schema/index.ts";
import { handOverMemberStorage, storageUsageOf } from "../src/storage.ts";
import { addFile, addFolder, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const names = (result: { status: string; nodes?: { name: string }[] }) =>
  result.nodes?.map((node) => node.name);

// Catches: a removal that fails on the owner foreign key, files lost or left with nobody, a
// second run that moves or nests them again, a name clash with what the recipient already has,
// Shared files or usage changing, and a share that stops working when its owner leaves.
test("a leaving member's My files move into one folder of whoever removed them, once", async () => {
  const org = await createOrg(db, "handover");
  const owner = await createMember(db, org.id, "owner");
  await setRole(db, owner.id, "owner");
  const admin = await createMember(db, org.id, "admin");
  await setRole(db, admin.id, "admin");
  const ben = await createMember(db, org.id, "Ben/Lee");
  const benStorage = forMember(db, ben.id).storage;
  const adminStorage = forMember(db, admin.id).storage;

  const docs = await addFolder(benStorage, { space: "personal" }, "Docs");
  const plan = await addFile(benStorage, { parentId: docs.id }, "plan.txt", 30);
  await addFile(benStorage, { space: "personal" }, "notes.txt", 5);
  const old = await addFile(benStorage, { space: "personal" }, "old.txt", 7);
  await benStorage.trash(old.id);
  const team = await addFile(benStorage, { space: "shared" }, "team.txt", 11);
  await benStorage.putGrant(plan.id, "client@outside.test", "viewer");
  // The admin already has a folder and a file with the names Ben used.
  await addFolder(adminStorage, { space: "personal" }, "Docs");
  await addFile(adminStorage, { space: "personal" }, "notes.txt", 1);
  const usage = await storageUsageOf(db, org.id);

  const moved = await handOverMemberStorage(db, { memberId: ben.id, toMemberId: admin.id });
  expect(moved).toMatchObject({ status: "ok", moved: 4, toMemberId: admin.id });
  const folderId = moved.status === "ok" ? moved.folderId! : "";

  // A slash in a person's name would not be a valid node name.
  expect(names(await adminStorage.list({ space: "personal" }))).toEqual([
    "Docs",
    "Files from Ben Lee",
    "notes.txt",
  ]);
  expect(names(await adminStorage.list({ parentId: folderId }))).toEqual(["Docs", "notes.txt"]);
  expect(names(await adminStorage.list({ parentId: docs.id }))).toEqual(["plan.txt"]);
  expect((await adminStorage.file(plan.id)).status).toBe("ok");
  // What Ben had trashed is the admin's to restore, back beside the rest.
  expect((await adminStorage.listTrash()).nodes.map((node) => node.name)).toEqual(["old.txt"]);
  expect(await adminStorage.restore(old.id)).toMatchObject({
    status: "ok",
    node: { parentId: folderId },
  });
  // Private stays private: the owner did not remove Ben, so the owner sees none of it.
  expect((await forMember(db, owner.id).storage.file(plan.id)).status).toBe("not_found");
  expect((await adminStorage.sharing(plan.id)).status).toBe("ok");
  expect(await storageUsageOf(db, org.id)).toEqual(usage);

  // Run twice: nothing left to move, no second folder.
  expect(await handOverMemberStorage(db, { memberId: ben.id, toMemberId: admin.id })).toEqual({
    status: "ok",
    moved: 0,
    folderId: null,
    toMemberId: null,
  });
  expect(names(await adminStorage.list({ space: "personal" }))).toHaveLength(3);

  // The member row can go now; an upload Ben left open goes with it.
  const open = await benStorage.openUpload(
    { space: "shared" },
    { name: "half.bin", size: 9, limitBytes: null },
  );
  expect(open.status).toBe("ok");
  await db.delete(members).where(eq(members.id, ben.id));
  expect((await adminStorage.file(team.id)).status).toBe("ok");
  const [shared] = await db.select().from(storageNodes).where(eq(storageNodes.id, team.id));
  expect(shared).toMatchObject({ space: "shared", createdByMemberId: null });
});

// Catches: files handed to the person leaving, to someone in another workspace, or to nobody.
test("without a remover the files go to the workspace's owner, never to the member or outside", async () => {
  const org = await createOrg(db, "handover-leave");
  const owner = await createMember(db, org.id, "owner");
  await setRole(db, owner.id, "owner");
  const elsewhere = await createOrg(db, "handover-elsewhere");
  const outsider = await createMember(db, elsewhere.id, "outsider");
  await setRole(db, outsider.id, "owner");

  // Named as the recipient: the member themselves (they left), then someone in another workspace.
  for (const [name, to] of [
    ["cy", null],
    ["dee", outsider.id],
  ] as const) {
    const member = await createMember(db, org.id, name);
    const file = await addFile(forMember(db, member.id).storage, { space: "personal" }, "mine.txt");
    const moved = await handOverMemberStorage(db, {
      memberId: member.id,
      toMemberId: to ?? member.id,
    });
    expect(moved).toMatchObject({ status: "ok", moved: 1, toMemberId: owner.id });
    expect((await forMember(db, owner.id).storage.file(file.id)).status).toBe("ok");
    expect((await forMember(db, outsider.id).storage.file(file.id)).status).toBe("not_found");
  }

  // The only owner cannot hand their files to anyone: nothing moves, and their row stays put.
  const solo = await createOrg(db, "handover-solo");
  const only = await createMember(db, solo.id, "only");
  await setRole(db, only.id, "owner");
  const kept = await addFile(forMember(db, only.id).storage, { space: "personal" }, "kept.txt");
  expect(await handOverMemberStorage(db, { memberId: only.id })).toEqual({
    status: "no_recipient",
  });
  expect((await forMember(db, only.id).storage.file(kept.id)).status).toBe("ok");
});
