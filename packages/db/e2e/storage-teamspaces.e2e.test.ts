import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { members, notifications, storageNodes, users } from "../src/schema/index.ts";
import { handOverMemberStorage, teamspaceAudience, teamspaceFileAudience } from "../src/storage.ts";
import { addFile, addFolder, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const names = (result: { status: string; nodes?: { name: string }[] }) =>
  result.nodes?.map((node) => node.name);

async function teamspace(
  storage: ReturnType<typeof forMember>["storage"],
  name: string,
  options: { private?: boolean; memberIds?: string[] } = {},
) {
  const made = await storage.createTeamspace({ name, ...options });
  if (made.status !== "ok") throw new Error(`teamspace: ${made.status}`);
  return made.teamspace;
}

test("a private teamspace is reached by its members alone, and nobody else sees it exists", async () => {
  const org = await createOrg(db, "ts-private");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const cy = await createMember(db, org.id, "cy");
  const anaStorage = forMember(db, ana.id).storage;
  const benStorage = forMember(db, ben.id).storage;
  const cyStorage = forMember(db, cy.id).storage;

  const legal = await teamspace(anaStorage, "Legal", { private: true, memberIds: [ben.id] });
  const contract = await addFile(anaStorage, { teamspaceId: legal.id }, "nda.pdf");

  expect(names(await benStorage.list({ teamspaceId: legal.id }))).toEqual(["nda.pdf"]);
  expect((await benStorage.teamspaces()).map((t) => [t.name, t.role, t.manage])).toEqual([
    ["Legal", "member", false],
  ]);

  expect(await cyStorage.teamspaces()).toEqual([]);
  expect((await cyStorage.list({ teamspaceId: legal.id })).status).toBe("not_found");
  expect(await cyStorage.node(contract.id)).toBeNull();
  expect((await cyStorage.file(contract.id)).status).toBe("not_found");
  expect((await cyStorage.createFolder({ teamspaceId: legal.id }, "Mine")).status).toBe(
    "not_found",
  );
  expect(await cyStorage.search("nda")).toEqual([]);
  expect((await benStorage.search("nda")).map((node) => node.id)).toEqual([contract.id]);
  expect(await cyStorage.recent()).toEqual([]);
  expect((await teamspaceAudience(db, legal.id)).toSorted()).toEqual([ana.id, ben.id].toSorted());
  expect((await benStorage.recent()).map((node) => node.id)).toEqual([contract.id]);
});

test("an open teamspace is every member's, a freelancer's only once they are added", async () => {
  const org = await createOrg(db, "ts-open");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const fay = await createMember(db, org.id, "fay");
  await setRole(db, fay.id, "freelancer");
  const anaStorage = forMember(db, ana.id).storage;
  const fayStorage = forMember(db, fay.id).storage;

  const design = await teamspace(anaStorage, "Design");
  await addFolder(anaStorage, { teamspaceId: design.id }, "Logos");

  expect(names(await forMember(db, ben.id).storage.list({ teamspaceId: design.id }))).toEqual([
    "Logos",
  ]);
  expect((await forMember(db, ben.id).storage.teamspaces())[0]?.role).toBeNull();
  expect((await fayStorage.list({ teamspaceId: design.id })).status).toBe("not_found");
  expect(await fayStorage.teamspaces()).toEqual([]);

  expect((await fayStorage.joinTeamspace(design.id)).status).toBe("not_found");
  expect((await forMember(db, ben.id).storage.joinTeamspace(design.id)).status).toBe("ok");
  expect((await forMember(db, ben.id).storage.teamspaces())[0]?.role).toBe("member");
  expect((await anaStorage.putTeamspaceMember(design.id, fay.id, "member")).status).toBe("ok");
  expect(names(await fayStorage.list({ teamspaceId: design.id }))).toEqual(["Logos"]);
});

test("its owners and the workspace's admins manage it, and it always keeps an owner", async () => {
  const org = await createOrg(db, "ts-manage");
  const other = await createOrg(db, "ts-manage-other");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const boss = await createMember(db, org.id, "boss");
  const stranger = await createMember(db, other.id, "stranger");
  await setRole(db, boss.id, "admin");
  const anaStorage = forMember(db, ana.id).storage;
  const benStorage = forMember(db, ben.id).storage;
  const bossStorage = forMember(db, boss.id).storage;

  const ops = await teamspace(anaStorage, "Ops", { memberIds: [ben.id, stranger.id] });
  const members = await anaStorage.teamspaceMembers(ops.id);
  expect(members.status === "ok" && members.members.map((m) => [m.memberId, m.role])).toEqual([
    [ana.id, "owner"],
    [ben.id, "member"],
  ]);

  expect((await benStorage.updateTeamspace(ops.id, { name: "Mine now" })).status).toBe("forbidden");
  expect((await benStorage.putTeamspaceMember(ops.id, boss.id, "owner")).status).toBe("forbidden");
  expect((await anaStorage.putTeamspaceMember(ops.id, stranger.id, "member")).status).toBe(
    "not_in_workspace",
  );
  expect((await anaStorage.putTeamspaceMember(ops.id, ana.id, "member")).status).toBe("last_owner");
  expect((await anaStorage.removeTeamspaceMember(ops.id, ana.id)).status).toBe("last_owner");

  const renamed = await bossStorage.updateTeamspace(ops.id, { name: "Operations", private: true });
  expect(renamed.status === "ok" && [renamed.teamspace.name, renamed.teamspace.private]).toEqual([
    "Operations",
    true,
  ]);
  expect((await benStorage.removeTeamspaceMember(ops.id, ben.id)).status).toBe("ok");
  expect(await benStorage.teamspaces()).toEqual([]);
});

test("inside it, only the uploader, its owners and admins take something out", async () => {
  const org = await createOrg(db, "ts-remove");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const cy = await createMember(db, org.id, "cy");
  const anaStorage = forMember(db, ana.id).storage;
  const benStorage = forMember(db, ben.id).storage;
  const cyStorage = forMember(db, cy.id).storage;

  const sales = await teamspace(anaStorage, "Sales");
  const deck = await addFile(benStorage, { teamspaceId: sales.id }, "deck.key");
  const folder = await addFolder(cyStorage, { teamspaceId: sales.id }, "Leads");
  await addFile(benStorage, { parentId: folder.id }, "list.csv");

  expect((await cyStorage.trash(deck.id)).status).toBe("forbidden");
  expect((await cyStorage.trash(folder.id)).status).toBe("forbidden");
  expect((await anaStorage.trash(folder.id)).status).toBe("ok");
  expect((await benStorage.trash(deck.id)).status).toBe("ok");
  expect((await anaStorage.listTrash()).nodes.map((node) => node.name).toSorted()).toEqual([
    "Leads",
    "deck.key",
  ]);
  expect((await cyStorage.listTrash()).nodes.map((node) => node.name)).toEqual(["Leads"]);
});

test("a folder moves between teamspaces with everything in it, and names repeat across them", async () => {
  const org = await createOrg(db, "ts-move");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const anaStorage = forMember(db, ana.id).storage;
  const benStorage = forMember(db, ben.id).storage;

  const one = await teamspace(anaStorage, "One");
  const two = await teamspace(anaStorage, "Two", { private: true });
  const docs = await addFolder(anaStorage, { teamspaceId: one.id }, "Docs");
  await addFolder(anaStorage, { teamspaceId: two.id }, "Docs");
  const inside = await addFile(anaStorage, { parentId: docs.id }, "plan.md");

  expect((await benStorage.move(docs.id, { teamspaceId: two.id })).status).toBe("not_found");
  expect((await benStorage.move(docs.id, { space: "shared" })).status).toBe("forbidden");

  const moved = await anaStorage.move(docs.id, { teamspaceId: two.id });
  expect(moved.status === "ok" && [moved.node.teamspaceId, moved.node.name]).toEqual([
    two.id,
    "Docs (1)",
  ]);
  const [child] = await db.select().from(storageNodes).where(eq(storageNodes.id, inside.id));
  expect(child?.teamspaceId).toBe(two.id);
  expect(await benStorage.node(inside.id)).toBeNull();

  const back = await anaStorage.move(docs.id, { space: "shared" });
  expect(back.status === "ok" && [back.node.space, back.node.teamspaceId]).toEqual([
    "shared",
    null,
  ]);
  const [shared] = await db.select().from(storageNodes).where(eq(storageNodes.id, inside.id));
  expect([shared?.space, shared?.teamspaceId]).toEqual(["shared", null]);
});

test("a teamspace is deleted once it holds nothing outside Trash, and its Trash goes with it", async () => {
  const org = await createOrg(db, "ts-delete");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const anaStorage = forMember(db, ana.id).storage;

  const temp = await teamspace(anaStorage, "Temp");
  const file = await addFile(anaStorage, { teamspaceId: temp.id }, "old.txt", 25);

  expect((await forMember(db, ben.id).storage.deleteTeamspace(temp.id)).status).toBe("forbidden");
  expect((await anaStorage.deleteTeamspace(temp.id)).status).toBe("not_empty");
  expect((await anaStorage.trash(file.id)).status).toBe("ok");
  const usageBefore = (await anaStorage.usage())?.bytes;

  const deleted = await anaStorage.deleteTeamspace(temp.id);
  expect(deleted).toMatchObject({ status: "ok" });
  expect(deleted.status === "ok" && deleted.r2Keys.length).toBe(1);
  expect(await anaStorage.teamspaces()).toEqual([]);
  expect(await db.select().from(storageNodes).where(eq(storageNodes.id, file.id))).toEqual([]);
  expect((await anaStorage.usage())?.bytes).toBe((usageBefore ?? 0) - 25);
});

test("a private teamspace's only owner leaving hands it to whoever takes their files, and admins always reach it", async () => {
  const org = await createOrg(db, "ts-leave");
  const ana = await createMember(db, org.id, "ana");
  const boss = await createMember(db, org.id, "boss");
  const cy = await createMember(db, org.id, "cy");
  await setRole(db, boss.id, "admin");
  const anaStorage = forMember(db, ana.id).storage;

  const secret = await teamspace(anaStorage, "Secret", { private: true });
  const note = await addFile(anaStorage, { teamspaceId: secret.id }, "note.txt");
  expect((await forMember(db, boss.id).storage.file(note.id)).status).toBe("ok");
  expect((await forMember(db, cy.id).storage.file(note.id)).status).toBe("not_found");

  expect((await handOverMemberStorage(db, { memberId: ana.id, toMemberId: cy.id })).status).toBe(
    "ok",
  );
  await db.delete(members).where(eq(members.id, ana.id));
  const cyStorage = forMember(db, cy.id).storage;
  expect((await cyStorage.teamspaces()).map((t) => [t.name, t.role])).toEqual([
    ["Secret", "owner"],
  ]);
  expect((await cyStorage.file(note.id)).status).toBe("ok");
});

test("someone taken out of a private teamspace hears no more about its comments", async () => {
  const org = await createOrg(db, "ts-comments");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const anaStorage = forMember(db, ana.id).storage;
  const benStorage = forMember(db, ben.id).storage;

  const legal = await teamspace(anaStorage, "Legal", { private: true, memberIds: [ben.id] });
  const file = await addFile(benStorage, { teamspaceId: legal.id }, "draft.txt");
  const first = await anaStorage.addComment(file.id, {
    body: "Looks good",
    anchor: { kind: "file" },
  });
  if (first.status !== "ok") throw new Error(first.status);
  expect(
    (await db.select().from(notifications).where(eq(notifications.memberId, ben.id))).length,
  ).toBe(1);

  expect((await anaStorage.removeTeamspaceMember(legal.id, ben.id)).status).toBe("ok");
  const second = await anaStorage.addComment(file.id, {
    body: "Secret terms",
    anchor: { kind: "file" },
  });
  if (second.status !== "ok") throw new Error(second.status);
  expect(
    (await db.select().from(notifications).where(eq(notifications.memberId, ben.id))).length,
  ).toBe(1);

  const [benUser] = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(members, eq(members.userId, users.id))
    .where(eq(members.id, ben.id));
  await db.update(users).set({ emailVerified: true }).where(eq(users.email, benUser!.email));
  expect((await anaStorage.putGrant(file.id, benUser!.email, "viewer")).status).toBe("ok");
  expect((await benStorage.file(file.id)).status).toBe("ok");
  const third = await anaStorage.addComment(file.id, {
    body: "Final price",
    anchor: { kind: "file" },
  });
  if (third.status !== "ok") throw new Error(third.status);
  expect(
    (await db.select().from(notifications).where(eq(notifications.memberId, ben.id))).length,
  ).toBe(1);
});

test("whoever a teamspace file is shared with hears its live edits, and nobody else outside it", async () => {
  const org = await createOrg(db, "ts-live");
  const ana = await createMember(db, org.id, "ana");
  const gil = await createMember(db, org.id, "gil");
  const cy = await createMember(db, org.id, "cy");
  const anaStorage = forMember(db, ana.id).storage;
  const board = await teamspace(anaStorage, "Board", { private: true });
  const doc = await addFile(anaStorage, { teamspaceId: board.id }, "plan.md");
  const [gilUser] = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(members, eq(members.userId, users.id))
    .where(eq(members.id, gil.id));
  await db.update(users).set({ emailVerified: true }).where(eq(users.email, gilUser!.email));

  expect(await teamspaceFileAudience(db, doc.id)).toEqual([ana.id]);
  expect((await anaStorage.putGrant(doc.id, gilUser!.email, "editor")).status).toBe("ok");
  expect((await teamspaceFileAudience(db, doc.id)).toSorted()).toEqual([ana.id, gil.id].toSorted());
  expect((await teamspaceFileAudience(db, doc.id)).includes(cy.id)).toBe(false);
});

test("a colleague outside a private teamspace, given a folder in it, trashes what they uploaded and nothing else", async () => {
  const org = await createOrg(db, "ts-grant-trash");
  const ana = await createMember(db, org.id, "ana");
  const cy = await createMember(db, org.id, "cy");
  const anaStorage = forMember(db, ana.id).storage;
  const cyStorage = forMember(db, cy.id).storage;
  const legal = await teamspace(anaStorage, "Legal", { private: true });
  const inbox = await addFolder(anaStorage, { teamspaceId: legal.id }, "Inbox");
  const anas = await addFile(anaStorage, { teamspaceId: legal.id, parentId: inbox.id }, "a.txt");
  const [cyUser] = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(members, eq(members.userId, users.id))
    .where(eq(members.id, cy.id));
  await db.update(users).set({ emailVerified: true }).where(eq(users.email, cyUser!.email));
  expect((await anaStorage.putGrant(inbox.id, cyUser!.email, "editor")).status).toBe("ok");

  const cys = await addFile(cyStorage, { teamspaceId: legal.id, parentId: inbox.id }, "c.txt");
  expect((await cyStorage.trash(anas.id)).status).not.toBe("ok");
  expect((await cyStorage.trash(cys.id)).status).toBe("ok");
});
