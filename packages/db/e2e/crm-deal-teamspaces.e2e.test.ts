import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { members, storageNodes } from "../src/schema/index.ts";
import { addFile, createPerson, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

test("a new deal gets an open teamspace of its own, and its files live there", async () => {
  const org = await createOrg(db, "deal-teamspace");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const cy = await createMember(db, org.id, "cy");
  await setRole(db, ana.id, "owner");
  const team = forMember(db, ana.id);

  const deal = ok(
    await team.crm.createDeal({ name: "Website rebuild", ownerMemberId: ben.id }),
  ).deal;
  expect(deal.teamspaceId).not.toBeNull();
  const members = ok(await team.storage.teamspaceMembers(deal.teamspaceId!)).members;
  expect(members.map((m) => [m.memberId, m.role]).toSorted()).toEqual(
    [
      [ana.id, "owner"],
      [ben.id, "member"],
    ].toSorted(),
  );

  const folder = ok(await team.crm.dealFolder(deal.id)).nodeId;
  const file = await addFile(team.storage, { parentId: folder }, "brief.pdf");
  const [row] = await db.select().from(storageNodes).where(eq(storageNodes.id, file.id));
  expect([row?.space, row?.teamspaceId]).toEqual(["teamspace", deal.teamspaceId]);

  const cyStorage = forMember(db, cy.id).storage;
  expect((await cyStorage.teamspaces()).map((t) => [t.name, t.role])).toEqual([
    ["Website rebuild", null],
  ]);
  expect((await cyStorage.file(file.id)).status).toBe("ok");
});

test("a freelancer on the project reaches its folder by grant, never the rest of its teamspace", async () => {
  const org = await createOrg(db, "deal-teamspace-freelancer");
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  const team = forMember(db, ana.id);
  const user = await createPerson(db, "fran@deal-teamspace.test");
  const [fran] = await db
    .insert(members)
    .values({
      id: randomUUID(),
      organizationId: org.id,
      userId: user.id,
      role: "freelancer",
      createdAt: new Date(),
    })
    .returning();
  const franStorage = forMember(db, fran!.id).storage;

  const deal = ok(await team.crm.createDeal({ name: "App" })).deal;
  const folder = ok(await team.crm.dealFolder(deal.id)).nodeId;
  const elsewhere = await addFile(team.storage, { teamspaceId: deal.teamspaceId! }, "budget.xlsx");
  ok(
    await team.crm.grantProjectAccess(deal.id, {
      email: "Fran@deal-teamspace.test",
      scope: "freelancer",
    }),
  );

  expect(await franStorage.teamspaces()).toEqual([]);
  expect((await franStorage.list({ teamspaceId: deal.teamspaceId! })).status).toBe("not_found");
  expect((await franStorage.file(elsewhere.id)).status).toBe("not_found");
  const asUser = forUser(db, user.id).storage;
  expect((await asUser.list({ parentId: folder })).status).toBe("ok");
});

test("a deal named with a slash still gets its space, and a freelancer owning it is not let in", async () => {
  const org = await createOrg(db, "deal-teamspace-names");
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  const fay = await createMember(db, org.id, "fay");
  await setRole(db, fay.id, "freelancer");
  const team = forMember(db, ana.id);

  const deal = ok(
    await team.crm.createDeal({ name: "Design / Build", ownerMemberId: fay.id }),
  ).deal;
  expect(deal.teamspaceId).not.toBeNull();
  expect((await team.storage.teamspaces()).map((t) => t.name)).toEqual(["Design - Build"]);
  const people = ok(await team.storage.teamspaceMembers(deal.teamspaceId!)).members;
  expect(people.map((m) => m.memberId)).toEqual([ana.id]);
  expect(await forMember(db, fay.id).storage.teamspaces()).toEqual([]);
});
