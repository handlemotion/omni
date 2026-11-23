import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { STORAGE_FIND_LIMIT } from "../src/storage/find.ts";
import { addFile, addFolder, addTeamspace } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const names = (nodes: { name: string }[]) => nodes.map((node) => node.name);

test("Search shows the member's teamspaces, live ones only, never My files or Shared", async () => {
  const org = await createOrg(db, "find");
  const other = await createOrg(db, "find-other");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const cy = await createMember(db, other.id, "cy");
  const mine = forMember(db, ana.id).storage;
  const bens = forMember(db, ben.id).storage;
  const studio = await addTeamspace(mine, "Studio");
  const open = await addTeamspace(bens, "Open");
  const hidden = await addTeamspace(bens, "Hidden", { private: true });

  const notes = await addFolder(mine, studio, "Notes");
  await addFile(mine, { parentId: notes.id }, "plan.txt");
  await addFile(bens, open, "plan-team.txt");
  await addFile(bens, hidden, "plan-ben.txt");
  await addFile(mine, { space: "personal" }, "plan-mine.txt");
  await addFile(mine, { space: "shared" }, "plan-shared.txt");
  const cys = forMember(db, cy.id).storage;
  await addFile(cys, await addTeamspace(cys, "Elsewhere"), "plan-cy.txt");
  const old = await addFolder(mine, studio, "Old");
  await addFile(mine, { parentId: old.id }, "plan-old.txt");
  expect((await mine.trash(old.id)).status).toBe("ok");
  expect(names(await mine.search("PLAN"))).toEqual(["plan-team.txt", "plan.txt"]);
  expect(names(await mine.search("note"))).toEqual(["Notes"]);
});

test("Search fills its page with live matches past ones deep in Trash", async () => {
  const org = await createOrg(db, "find-deep");
  const ana = await createMember(db, org.id, "ana");
  const mine = forMember(db, ana.id).storage;
  const studio = await addTeamspace(mine, "Studio");
  const old = await addFolder(mine, studio, "Old");
  const inner = await addFolder(mine, { parentId: old.id }, "Inner");
  for (let i = 0; i < STORAGE_FIND_LIMIT; i += 1) {
    await addFile(mine, { parentId: inner.id }, `a-report-${String(i).padStart(2, "0")}.txt`);
  }
  const kept = await addFolder(mine, studio, "Kept");
  await addFile(mine, { parentId: kept.id }, "z-report.txt");
  expect((await mine.trash(old.id)).status).toBe("ok");

  expect(names(await mine.search("report"))).toEqual(["z-report.txt"]);
});

test("Search matches % and _ as themselves", async () => {
  const org = await createOrg(db, "find-like");
  const ana = await createMember(db, org.id, "ana");
  const mine = forMember(db, ana.id).storage;
  const studio = await addTeamspace(mine, "Studio");
  await addFile(mine, studio, "100% done.txt");
  await addFile(mine, studio, "a_b.txt");
  await addFile(mine, studio, "axb.txt");

  expect(names(await mine.search("%"))).toEqual(["100% done.txt"]);
  expect(names(await mine.search("a_b"))).toEqual(["a_b.txt"]);
});

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

test("A team-only, typed search finds a PDF behind a full page of other types", async () => {
  const org = await createOrg(db, "find-team");
  const ana = await createMember(db, org.id, "ana");
  const mine = forMember(db, ana.id).storage;
  const studio = await addTeamspace(mine, "Studio");
  for (let i = 0; i < STORAGE_FIND_LIMIT; i += 1) {
    await addFile(
      mine,
      studio,
      `a-msa-${String(i).padStart(2, "0")}.docx`,
      10,
      "application/msword",
    );
  }
  await addFile(mine, { space: "personal" }, "b-msa.pdf", 10, "application/pdf");
  const legal = await addFolder(mine, studio, "MSA archive");
  await addFile(mine, studio, "z-msa.pdf", 10, "application/pdf");

  expect(names(await mine.search("msa"))).not.toContain("z-msa.pdf");
  expect(names(await mine.search("msa", { teamOnly: true, type: "application/pdf" }))).toEqual([
    legal.name,
    "z-msa.pdf",
  ]);
});
