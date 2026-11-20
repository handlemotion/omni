import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import {
  mailDomains,
  members,
  organizations,
  storageGrants,
  storageNodes,
  storageUploads,
  storageUsage,
  userEmails,
  users,
} from "../src/schema/index.ts";
import {
  publicStorage,
  publicStorageNode,
  STORAGE_MAX_DEPTH,
  STORAGE_NAME_MAX_LENGTH,
} from "../src/storage.ts";
import { addFile, addFolder, createPerson, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const names = (result: { status: string; nodes?: { name: string }[] }) =>
  result.nodes?.map((node) => node.name);

test("a Personal space has My files and no Shared", async () => {
  const person = await createPerson(db, "solo@personal.test");
  const orgId = await ensurePersonalSpace(db, person.id);
  const [member] = await db.select().from(members).where(eq(members.organizationId, orgId));
  const storage = forMember(db, member!.id).storage;

  expect((await storage.createFolder({ space: "personal" }, "Mine")).status).toBe("ok");
  expect((await storage.list({ space: "shared" })).status).toBe("not_found");
  expect((await storage.createFolder({ space: "shared" }, "Team")).status).toBe("not_found");
  expect(
    (await storage.openUpload({ space: "shared" }, { name: "a.txt", size: 1, limitBytes: null }))
      .status,
  ).toBe("not_found");
  const [stray] = await db
    .insert(storageNodes)
    .values({ orgId, space: "shared", kind: "folder", name: "Stray" })
    .returning();
  expect(await storage.node(stray!.id)).toBeNull();
});

test("in Shared every member reads and writes, and only the uploader or an admin trashes or takes out", async () => {
  const org = await createOrg(db, "shared-rules");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const admin = await createMember(db, org.id, "admin");
  await setRole(db, admin.id, "admin");
  const anaStorage = forMember(db, ana.id).storage;
  const benStorage = forMember(db, ben.id).storage;
  const adminStorage = forMember(db, admin.id).storage;

  const plans = await addFolder(anaStorage, { space: "shared" }, "Plans");
  const budget = await addFile(anaStorage, { parentId: plans.id }, "budget.xlsx");

  expect(names(await benStorage.list({ parentId: plans.id }))).toEqual(["budget.xlsx"]);
  expect((await benStorage.file(budget.id)).status).toBe("ok");
  expect((await benStorage.rename(budget.id, "budget-2027.xlsx")).status).toBe("ok");
  expect((await benStorage.createFolder({ parentId: plans.id }, "Drafts")).status).toBe("ok");

  expect((await benStorage.trash(budget.id)).status).toBe("forbidden");
  expect((await benStorage.move(budget.id, { space: "personal" })).status).toBe("forbidden");
  expect((await anaStorage.trash(budget.id)).status).toBe("ok");

  expect((await benStorage.listTrash()).nodes).toEqual([]);
  expect((await benStorage.restore(budget.id)).status).toBe("forbidden");
  expect((await benStorage.deleteForever(budget.id)).status).toBe("forbidden");
  expect((await anaStorage.listTrash()).nodes.map((node) => node.id)).toEqual([budget.id]);
  expect((await adminStorage.listTrash()).nodes.map((node) => node.id)).toEqual([budget.id]);
  expect((await adminStorage.restore(budget.id)).status).toBe("ok");
  expect(names(await benStorage.list({ parentId: plans.id }))).toEqual([
    "Drafts",
    "budget-2027.xlsx",
  ]);
});

test("a grant on a folder opens a file two levels down for that address only, and removing it closes it", async () => {
  const org = await createOrg(db, "grants");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const top = await addFolder(storage, { space: "personal" }, "Client");
  const mid = await addFolder(storage, { parentId: top.id }, "2026");
  const file = await addFile(storage, { parentId: mid.id }, "contract.pdf");
  const beside = await addFile(storage, { space: "personal" }, "private.txt");

  const guest = await createPerson(db, "guest@outside.test");
  const stranger = await createPerson(db, "stranger@outside.test");
  const [unproven] = await db
    .insert(users)
    .values({ id: crypto.randomUUID(), name: "unproven", email: "unproven@outside.test" })
    .returning();
  const put = await storage.putGrant(top.id, " Guest@Outside.test ", "viewer");
  expect(put).toMatchObject({ status: "ok", created: true });
  await storage.putGrant(top.id, "unproven@outside.test", "viewer");

  const guestStorage = forUser(db, guest.id).storage;
  const opened = await guestStorage.file(file.id);
  expect(opened).toMatchObject({ status: "ok", r2Key: `orgs/${org.id}/${file.id}` });
  expect((await guestStorage.node(file.id))?.path.map((entry) => entry.name)).toEqual([
    "Client",
    "2026",
    "contract.pdf",
  ]);
  expect(await guestStorage.node(beside.id)).toBeNull();
  expect((await forUser(db, stranger.id).storage.file(file.id)).status).toBe("not_found");
  expect((await forUser(db, unproven!.id).storage.file(file.id)).status).toBe("not_found");
  expect((await guestStorage.sharedWithMe()).items.map((item) => item.node.id)).toEqual([top.id]);

  expect((await guestStorage.createFolder({ parentId: mid.id }, "x")).status).toBe("forbidden");
  expect((await guestStorage.rename(file.id, "mine.pdf")).status).toBe("forbidden");
  expect((await guestStorage.trash(file.id)).status).toBe("forbidden");

  expect((await storage.removeGrant(top.id, "guest@outside.test")).status).toBe("ok");
  expect((await guestStorage.file(file.id)).status).toBe("not_found");
  expect((await guestStorage.list({ parentId: top.id })).status).toBe("not_found");
  expect((await guestStorage.sharedWithMe()).items).toEqual([]);
});

test("an editor grant writes inside the granted folder and nowhere else, and never shares", async () => {
  const org = await createOrg(db, "editors");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const project = await addFolder(storage, { space: "personal" }, "Project");
  const inner = await addFolder(storage, { parentId: project.id }, "Inner");
  const notes = await addFile(storage, { parentId: project.id }, "notes.txt");
  const other = await addFolder(storage, { space: "personal" }, "Other");
  const secret = await addFile(storage, { parentId: other.id }, "secret.txt");

  const editor = await createPerson(db, "editor@outside.test");
  await ensurePersonalSpace(db, editor.id);
  await storage.putGrant(project.id, "editor@outside.test", "editor");
  const editing = forUser(db, editor.id).storage;

  const uploaded = await addFile(editing, { parentId: inner.id }, "upload.txt");
  expect(uploaded).toMatchObject({ orgId: org.id, space: "personal", ownerMemberId: ana.id });
  expect((await editing.createFolder({ parentId: project.id }, "New")).status).toBe("ok");
  expect((await editing.rename(notes.id, "notes-v2.txt")).status).toBe("ok");
  expect((await editing.move(notes.id, { parentId: inner.id })).status).toBe("ok");
  expect((await editing.trash(uploaded.id)).status).toBe("ok");

  expect((await editing.rename(project.id, "Taken")).status).toBe("forbidden");
  expect((await editing.trash(project.id)).status).toBe("forbidden");
  expect((await editing.trash(secret.id)).status).toBe("not_found");
  expect((await editing.move(notes.id, { parentId: other.id })).status).toBe("not_found");
  expect((await editing.move(secret.id, { parentId: inner.id })).status).toBe("not_found");
  expect((await editing.createFolder({ parentId: other.id }, "x")).status).toBe("not_found");
  expect((await editing.createFolder({ space: "personal" }, "x")).status).toBe("not_found");
  expect(
    (await editing.openUpload({ parentId: other.id }, { name: "x", size: 1, limitBytes: null }))
      .status,
  ).toBe("not_found");
  expect(Object.keys(editing)).not.toEqual(
    expect.arrayContaining(["putGrant", "setLinkAccess", "restore", "deleteForever", "listTrash"]),
  );

  await storage.putGrant(project.id, "editor@outside.test", "viewer");
  expect((await editing.createFolder({ parentId: inner.id }, "Late")).status).toBe("forbidden");
});

test("an editor whose grant is removed mid-upload cannot complete it", async () => {
  const org = await createOrg(db, "mid-upload");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const inbox = await addFolder(storage, { space: "personal" }, "Inbox");
  const editor = await createPerson(db, "late@outside.test");
  await ensurePersonalSpace(db, editor.id);
  await storage.putGrant(inbox.id, "late@outside.test", "editor");
  const editing = forUser(db, editor.id).storage;

  const opened = await editing.openUpload(
    { parentId: inbox.id },
    { name: "big.bin", size: 5, limitBytes: null },
  );
  if (opened.status !== "ok") throw new Error(opened.status);
  await editing.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "e", size: 5 });
  await storage.removeGrant(inbox.id, "late@outside.test");

  expect((await editing.completeUpload(opened.upload.id, { limitBytes: null })).status).toBe(
    "not_found",
  );
  expect(names(await storage.list({ parentId: inbox.id }))).toEqual([]);
});

test("a session scoped to a company sees only grants addressed to that company's domains", async () => {
  const acme = await createOrg(db, "acme");
  await db.insert(mailDomains).values({ orgId: acme.id, domain: "acme.test", provider: "imap" });
  const person = await createPerson(db, "pat@gmail.test");
  await db
    .insert(userEmails)
    .values({ userId: person.id, email: "pat@acme.test", verifiedAt: new Date() });

  const elsewhere = await createOrg(db, "elsewhere");
  const owner = await createMember(db, elsewhere.id, "owner");
  const storage = forMember(db, owner.id).storage;
  const toPersonal = await addFile(storage, { space: "personal" }, "for-pat-personally.txt");
  const toWork = await addFile(storage, { space: "personal" }, "for-pat-at-acme.txt");
  const personal = await storage.putGrant(toPersonal.id, "pat@gmail.test", "viewer");
  if (personal.status !== "ok") throw new Error(personal.status);
  await storage.putGrant(toWork.id, "pat@acme.test", "viewer");

  const unscoped = forUser(db, person.id).storage;
  expect((await unscoped.sharedWithMe()).items.map((item) => item.node.name).toSorted()).toEqual([
    "for-pat-at-acme.txt",
    "for-pat-personally.txt",
  ]);

  const scoped = forUser(db, person.id, acme.id).storage;
  expect((await scoped.sharedWithMe()).items.map((item) => item.node.name)).toEqual([
    "for-pat-at-acme.txt",
  ]);
  expect((await scoped.file(toWork.id)).status).toBe("ok");
  expect((await scoped.file(toPersonal.id)).status).toBe("not_found");
  expect(await scoped.nodeByShareId(personal.shareId)).toBeNull();
});

test("a Restricted link opens nothing without a grant, Anyone opens it, and a reset kills the old link", async () => {
  const org = await createOrg(db, "links");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const folder = await addFolder(storage, { space: "personal" }, "Press kit");
  const sub = await addFolder(storage, { parentId: folder.id }, "Logos");
  const logo = await addFile(storage, { parentId: sub.id }, "logo.svg");
  const outside = await addFile(storage, { space: "personal" }, "payroll.csv");

  const guest = await createPerson(db, "press@outside.test");
  const granted = await storage.putGrant(folder.id, "press@outside.test", "viewer");
  if (granted.status !== "ok") throw new Error(granted.status);
  const shareId = granted.shareId;
  expect(shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);

  expect(await publicStorageNode(db, shareId)).toBeNull();
  expect((await publicStorage(db, shareId).file(logo.id)).status).toBe("not_found");
  expect((await forUser(db, guest.id).storage.nodeByShareId(shareId))?.node.id).toBe(folder.id);

  const opened = await storage.setLinkAccess(folder.id, "anyone");
  expect(opened).toMatchObject({ status: "ok", sharing: { shareId, linkAccess: "anyone" } });
  const link = publicStorage(db, shareId);
  expect(await link.node()).toMatchObject({ role: "viewer", node: { id: folder.id } });
  expect(names(await link.list({}))).toEqual(["Logos"]);
  expect(names(await link.list({ parentId: sub.id }))).toEqual(["logo.svg"]);
  expect(await link.file(logo.id)).toMatchObject({
    status: "ok",
    r2Key: `orgs/${org.id}/${logo.id}`,
  });
  expect((await link.node(logo.id))?.path.map((entry) => entry.name)).toEqual([
    "Press kit",
    "Logos",
    "logo.svg",
  ]);
  expect((await link.file(outside.id)).status).toBe("not_found");
  expect(await link.node(outside.id)).toBeNull();

  const reset = await storage.resetLink(folder.id);
  if (reset.status !== "ok") throw new Error(reset.status);
  expect(reset.sharing.shareId).not.toBe(shareId);
  expect(await publicStorageNode(db, shareId)).toBeNull();
  expect((await publicStorage(db, shareId).file(logo.id)).status).toBe("not_found");
  expect((await publicStorage(db, reset.sharing.shareId!).file(logo.id)).status).toBe("ok");

  await storage.setLinkAccess(folder.id, "restricted");
  expect(await publicStorageNode(db, reset.sharing.shareId!)).toBeNull();
});

test("a trashed node, or one inside a trashed folder, is invisible through a grant and a link; restored, only the grant opens it", async () => {
  const org = await createOrg(db, "trash-doors");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const folder = await addFolder(storage, { space: "personal" }, "Shared out");
  const sub = await addFolder(storage, { parentId: folder.id }, "Sub");
  const file = await addFile(storage, { parentId: sub.id }, "doc.txt");
  const guest = await createPerson(db, "reader@outside.test");
  const granted = await storage.putGrant(file.id, "reader@outside.test", "viewer");
  if (granted.status !== "ok") throw new Error(granted.status);
  await storage.setLinkAccess(file.id, "anyone");
  const reading = forUser(db, guest.id).storage;
  expect((await reading.file(file.id)).status).toBe("ok");
  expect((await publicStorage(db, granted.shareId).file(file.id)).status).toBe("ok");

  await storage.trash(folder.id);
  expect((await reading.file(file.id)).status).toBe("not_found");
  expect(await reading.nodeByShareId(granted.shareId)).toBeNull();
  expect((await reading.sharedWithMe()).items).toEqual([]);
  expect(await publicStorageNode(db, granted.shareId)).toBeNull();
  expect((await publicStorage(db, granted.shareId).file(file.id)).status).toBe("not_found");
  expect(names(await storage.list({ space: "personal" }))).toEqual([]);
  expect((await storage.listTrash()).nodes.map((node) => node.id)).toEqual([folder.id]);

  expect((await storage.restore(folder.id)).status).toBe("ok");
  expect((await reading.file(file.id)).status).toBe("ok");
  expect((await publicStorage(db, granted.shareId).file(file.id)).status).toBe("not_found");
});

test("a taken name gets a number, also when many inserts race for it", async () => {
  const org = await createOrg(db, "names");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;

  const made = await Promise.all(
    Array.from({ length: 8 }, () => storage.createFolder({ space: "personal" }, "Report")),
  );
  expect(made.map((result) => result.status)).toEqual(Array.from({ length: 8 }, () => "ok"));
  expect(names(await storage.list({ space: "personal" }))).toEqual([
    "Report",
    ...Array.from({ length: 7 }, (_, n) => `Report (${n + 1})`),
  ]);

  const first = await addFile(storage, { space: "personal" }, "report.pdf");
  const second = await addFile(storage, { space: "personal" }, "REPORT.pdf");
  expect([first.name, second.name]).toEqual(["report.pdf", "REPORT (1).pdf"]);
  expect((await storage.rename(second.id, "Report.PDF")).status).toBe("name_taken");
  expect((await storage.rename(second.id, "a/b.pdf")).status).toBe("invalid_name");

  await storage.trash(first.id);
  const replacement = await addFile(storage, { space: "personal" }, "report.pdf");
  expect(replacement.name).toBe("report.pdf");
  expect(await storage.restore(first.id)).toMatchObject({
    status: "ok",
    node: { name: "report (2).pdf" },
  });
});

test("a move cannot make a cycle, pass the depth cap or leave the workspace, and takes its contents along", async () => {
  const org = await createOrg(db, "moves");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const storage = forMember(db, ana.id).storage;

  const a = await addFolder(storage, { space: "personal" }, "a");
  const b = await addFolder(storage, { parentId: a.id }, "b");
  const c = await addFolder(storage, { parentId: b.id }, "c");
  expect((await storage.move(a.id, { parentId: c.id })).status).toBe("cycle");
  expect((await storage.move(a.id, { parentId: a.id })).status).toBe("cycle");

  let deepest = await addFolder(storage, { space: "personal" }, "level-1");
  for (let level = 2; level <= STORAGE_MAX_DEPTH; level++) {
    deepest = await addFolder(storage, { parentId: deepest.id }, `level-${level}`);
  }
  expect((await storage.createFolder({ parentId: deepest.id }, "too far")).status).toBe("too_deep");
  expect((await addFile(storage, { parentId: deepest.id }, "leaf.txt")).parentId).toBe(deepest.id);
  expect((await storage.move(c.id, { parentId: deepest.id })).status).toBe("too_deep");
  expect((await storage.move(b.id, { parentId: deepest.parentId! })).status).toBe("too_deep");
  expect((await storage.move(c.id, { parentId: deepest.parentId! })).status).toBe("ok");

  const other = await createOrg(db, "moves-other");
  const [anaThere] = await db
    .insert(members)
    .values({
      id: crypto.randomUUID(),
      organizationId: other.id,
      userId: ana.userId,
      createdAt: new Date(),
    })
    .returning();
  const there = await addFolder(forMember(db, anaThere!.id).storage, { space: "personal" }, "x");
  expect((await storage.move(b.id, { parentId: there.id })).status).toBe("not_found");

  const inside = await addFile(storage, { parentId: b.id }, "inside.txt");
  const shared = await addFolder(storage, { space: "shared" }, "b");
  expect(await storage.move(b.id, { space: "shared" })).toMatchObject({
    status: "ok",
    node: { name: "b (1)", space: "shared", ownerMemberId: null, parentId: null },
  });
  expect(shared.name).toBe("b");
  const benStorage = forMember(db, ben.id).storage;
  expect((await benStorage.file(inside.id)).status).toBe("ok");
  expect((await storage.move(b.id, { space: "personal" })).status).toBe("ok");
  expect((await benStorage.file(inside.id)).status).toBe("not_found");
});

test("deleting a workspace takes its storage rows; deleting a member who still owns files is refused", async () => {
  const org = await createOrg(db, "cascade");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const file = await addFile(storage, { space: "personal" }, "kept.txt");
  await storage.putGrant(file.id, "someone@outside.test", "viewer");

  await expect(db.delete(members).where(eq(members.id, ana.id))).rejects.toMatchObject({
    cause: { constraint_name: "storage_nodes_owner_member_id_members_id_fk" },
  });
  expect((await storage.file(file.id)).status).toBe("ok");

  await db.delete(organizations).where(eq(organizations.id, org.id));
  for (const table of [storageNodes, storageGrants, storageUploads, storageUsage]) {
    expect(await db.select().from(table).where(eq(table.orgId, org.id))).toEqual([]);
  }
});

test("paged lists return every row once: a folder (folders first, by name), Trash and Shared with me", async () => {
  const org = await createOrg(db, "paging");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const guest = await createPerson(db, "pager@outside.test");
  const reading = forUser(db, guest.id).storage;
  for (const name of ["b.txt", "A.txt", "c.txt"]) {
    const file = await addFile(storage, { space: "personal" }, name);
    await storage.putGrant(file.id, "pager@outside.test", "viewer");
  }
  await addFolder(storage, { space: "personal" }, "zeta");
  await addFolder(storage, { space: "personal" }, "Alpha");

  const listed: string[] = [];
  let cursor: Parameters<typeof storage.list>[1] = { limit: 2 };
  for (;;) {
    const page = await storage.list({ space: "personal" }, cursor);
    if (page.status !== "ok") throw new Error(page.status);
    listed.push(...page.nodes.map((node) => node.name));
    if (!page.nextCursor) break;
    cursor = { limit: 2, cursor: page.nextCursor };
  }
  expect(listed).toEqual(["Alpha", "zeta", "A.txt", "b.txt", "c.txt"]);

  const shared: string[] = [];
  let sharedCursor: Parameters<typeof reading.sharedWithMe>[0] = { limit: 2 };
  for (;;) {
    const page = await reading.sharedWithMe(sharedCursor);
    shared.push(...page.items.map((item) => item.node.name));
    if (!page.nextCursor) break;
    sharedCursor = { limit: 2, cursor: page.nextCursor };
  }
  expect(shared.toSorted()).toEqual(["A.txt", "b.txt", "c.txt"]);

  const all = await storage.list({ space: "personal" });
  if (all.status !== "ok") throw new Error(all.status);
  for (const node of all.nodes) await storage.trash(node.id);
  const trashed: string[] = [];
  let trashCursor: Parameters<typeof storage.listTrash>[0] = { limit: 2 };
  for (;;) {
    const page = await storage.listTrash(trashCursor);
    trashed.push(...page.nodes.map((node) => node.name));
    if (!page.nextCursor) break;
    trashCursor = { limit: 2, cursor: page.nextCursor };
  }
  expect(trashed.toSorted()).toEqual(["A.txt", "Alpha", "b.txt", "c.txt", "zeta"]);
});

test("in Shared a folder holding a colleague's file is not its maker's to trash, take out or delete", async () => {
  const org = await createOrg(db, "shared-folders");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const admin = await createMember(db, org.id, "admin");
  await setRole(db, admin.id, "admin");
  const anaStorage = forMember(db, ana.id).storage;
  const benStorage = forMember(db, ben.id).storage;
  const adminStorage = forMember(db, admin.id).storage;

  const file = await addFile(anaStorage, { space: "shared" }, "ana.txt");
  const folder = await addFolder(benStorage, { space: "shared" }, "Ben's");
  const inner = await addFolder(benStorage, { parentId: folder.id }, "Inner");
  expect((await benStorage.move(file.id, { parentId: inner.id })).status).toBe("ok");

  expect((await benStorage.trash(folder.id)).status).toBe("forbidden");
  expect((await benStorage.trash(inner.id)).status).toBe("forbidden");
  expect((await benStorage.move(folder.id, { space: "personal" })).status).toBe("forbidden");
  expect((await anaStorage.file(file.id)).status).toBe("ok");
  expect((await adminStorage.trash(folder.id)).status).toBe("ok");
  expect((await benStorage.deleteForever(folder.id)).status).toBe("forbidden");
  expect((await adminStorage.restore(folder.id)).status).toBe("ok");

  expect((await anaStorage.move(file.id, { space: "shared" })).status).toBe("ok");
  await addFile(benStorage, { parentId: inner.id }, "ben.txt");
  expect((await benStorage.move(inner.id, { space: "personal" })).status).toBe("ok");
  expect((await benStorage.trash(folder.id)).status).toBe("ok");
  expect((await benStorage.deleteForever(folder.id)).status).toBe("ok");
  expect((await anaStorage.file(file.id)).status).toBe("ok");
});

test("an editor grant gives a member of the workspace no more right to trash in Shared than membership does", async () => {
  const org = await createOrg(db, "self-grant");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const anaStorage = forMember(db, ana.id).storage;
  const benStorage = forMember(db, ben.id).storage;
  const folder = await addFolder(anaStorage, { space: "shared" }, "Plans");
  const file = await addFile(anaStorage, { parentId: folder.id }, "ana.txt");
  const own = await addFile(benStorage, { parentId: folder.id }, "ben.txt");
  const [benUser] = await db
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, ben.userId))
    .returning();
  const outsider = await createPerson(db, "self-grant-editor@outside.test");

  expect((await benStorage.putGrant(folder.id, benUser!.email, "editor")).status).toBe("ok");
  await benStorage.putGrant(folder.id, outsider.email, "editor");
  const benGrant = forUser(db, ben.userId).storage;
  expect((await benGrant.node(file.id))?.role).toBe("editor");
  expect((await benGrant.trash(file.id)).status).toBe("forbidden");
  expect((await benGrant.rename(file.id, "renamed.txt")).status).toBe("ok");
  expect((await benGrant.trash(own.id)).status).toBe("ok");
  expect((await forUser(db, outsider.id).storage.trash(file.id)).status).toBe("ok");
});

test("a taken name at the length limit is numbered without passing the limit", async () => {
  const org = await createOrg(db, "long-names");
  const ana = await createMember(db, org.id, "ana");
  const storage = forMember(db, ana.id).storage;
  const folderName = "n".repeat(STORAGE_NAME_MAX_LENGTH);
  const fileName = `${"f".repeat(STORAGE_NAME_MAX_LENGTH - 4)}.pdf`;
  await addFolder(storage, { space: "personal" }, folderName);
  const folder = await addFolder(storage, { space: "personal" }, folderName);
  await addFile(storage, { space: "personal" }, fileName);
  const file = await addFile(storage, { space: "personal" }, fileName);

  for (const [node, original] of [
    [folder, folderName],
    [file, fileName],
  ] as const) {
    expect(node.name).not.toBe(original);
    expect(node.name.length).toBeLessThanOrEqual(STORAGE_NAME_MAX_LENGTH);
    expect((await storage.rename(node.id, node.name)).status).toBe("ok");
  }
  expect(file.name.endsWith(" (1).pdf")).toBe(true);
});
