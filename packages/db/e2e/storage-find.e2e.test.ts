// Drive's Search and the sidebar's cluster glyphs at the member door: what reaches across a
// member's drives.
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { addFile, addFolder } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const names = (nodes: { name: string }[]) => nodes.map((node) => node.name);

// Catches: a query over the workspace's rows that forgets My files belong to one member, so
// Search shows Ben's private files to Ana; another workspace's rows; and a file inside
// a trashed folder (only the folder carries `trashedAt`) still showing as live.
test("Search shows the member's own files and Shared, live ones only", async () => {
  const org = await createOrg(db, "find");
  const other = await createOrg(db, "find-other");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const cy = await createMember(db, other.id, "cy");
  const mine = forMember(db, ana.id).storage;

  const notes = await addFolder(mine, { space: "personal" }, "Notes");
  await addFile(mine, { parentId: notes.id }, "plan.txt");
  await addFile(mine, { space: "shared" }, "plan-shared.txt");
  await addFile(forMember(db, ben.id).storage, { space: "personal" }, "plan-ben.txt");
  await addFile(forMember(db, cy.id).storage, { space: "personal" }, "plan-cy.txt");
  const old = await addFolder(mine, { space: "personal" }, "Old");
  await addFile(mine, { parentId: old.id }, "plan-old.txt");
  expect((await mine.trash(old.id)).status).toBe("ok");
  expect(names(await mine.search("PLAN"))).toEqual(["plan-shared.txt", "plan.txt"]);
  expect(names(await mine.search("note"))).toEqual(["Notes"]);
});

// Catches: the query going into ILIKE unescaped, so "%" or "_" matches every name.
test("Search matches % and _ as themselves", async () => {
  const org = await createOrg(db, "find-like");
  const ana = await createMember(db, org.id, "ana");
  const mine = forMember(db, ana.id).storage;
  await addFile(mine, { space: "personal" }, "100% done.txt");
  await addFile(mine, { space: "personal" }, "a_b.txt");
  await addFile(mine, { space: "personal" }, "axb.txt");

  expect(names(await mine.search("%"))).toEqual(["100% done.txt"]);
  expect(names(await mine.search("a_b"))).toEqual(["a_b.txt"]);
});

// Catches: the glyph query keyed on the workspace alone, so Ana's sidebar shows Ben's private
// cluster glyphs (or Ben's folder ids); a glyph set on a nested folder; and a cluster in Trash
// keeping its glyph in the list.
test("Cluster glyphs are the member's own top-level folders only", async () => {
  const org = await createOrg(db, "icons");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const mine = forMember(db, ana.id).storage;
  const bens = forMember(db, ben.id).storage;

  const design = await addFolder(mine, { space: "personal" }, "Design");
  const old = await addFolder(mine, { space: "personal" }, "Old");
  const inner = await addFolder(mine, { parentId: design.id }, "Drafts");
  const team = await addFolder(mine, { space: "shared" }, "Team");
  const benPrivate = await addFolder(bens, { space: "personal" }, "Ben");

  expect((await mine.setIcon(design.id, "rocket")).status).toBe("ok");
  expect((await mine.setIcon(old.id, "archive")).status).toBe("ok");
  expect((await mine.setIcon(team.id, "star")).status).toBe("ok");
  expect((await bens.setIcon(benPrivate.id, "lock")).status).toBe("ok");
  expect((await mine.setIcon(inner.id, "heart")).status).toBe("not_found");
  expect((await mine.setIcon(benPrivate.id, "heart")).status).toBe("not_found");
  expect((await mine.trash(old.id)).status).toBe("ok");

  expect(await mine.folderIcons("personal")).toEqual({ [design.id]: "rocket" });
  expect(await mine.folderIcons("shared")).toEqual({ [team.id]: "star" });
  expect((await mine.setIcon(design.id, null)).status).toBe("ok");
  expect(await mine.folderIcons("personal")).toEqual({});
});
