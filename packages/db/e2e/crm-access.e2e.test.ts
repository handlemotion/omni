import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { crmDeals, crmEvents, crmNotes, members } from "../src/schema/index.ts";
import { createPerson, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

test("a member of another company gets nothing through the member door, by id or by list", async () => {
  const acme = await createOrg(db, "crm-leak-acme");
  const other = await createOrg(db, "crm-leak-other");
  const ana = forMember(db, (await createMember(db, acme.id, "ana")).id).crm;
  const eve = forMember(db, (await createMember(db, other.id, "eve")).id).crm;

  const person = ok(await ana.addPerson({ name: "Bea", address: "bea@client.test" })).person;
  const companyId = person.companyId!;
  const deal = ok(
    await ana.createDeal({ name: "Website", companyId, personIds: [person.id] }),
  ).deal;
  const note = ok(
    await ana.createNote({ record: { dealId: deal.id }, body: "Budget is fixed" }),
  ).note;

  expect((await eve.company(companyId)).status).toBe("not_found");
  expect((await eve.person(person.id)).status).toBe("not_found");
  expect((await eve.deal(deal.id)).status).toBe("not_found");
  expect((await eve.events({ dealId: deal.id })).status).toBe("not_found");
  expect((await eve.notes({ dealId: deal.id })).status).toBe("not_found");
  expect((await eve.updateDeal(deal.id, { name: "Mine now" })).status).toBe("not_found");
  expect((await eve.updatePerson(person.id, { name: "Mine" })).status).toBe("not_found");
  expect((await eve.addCompanyDomain(companyId, "evil.test")).status).toBe("not_found");
  expect((await eve.archiveCompany(companyId)).status).toBe("not_found");
  expect((await eve.createNote({ record: { personId: person.id }, body: "hi" })).status).toBe(
    "not_found",
  );
  expect((await eve.updateNote(note.id, { body: "edited" })).status).toBe("not_found");
  const ourStage = ok(await ana.stages()).stages[0]!;
  expect((await eve.createDeal({ name: "x", companyId })).status).toBe("not_found");
  expect((await eve.createDeal({ name: "x", personIds: [person.id] })).status).toBe("not_found");
  expect((await eve.createDeal({ name: "x", stageId: ourStage.id })).status).toBe("not_found");
  expect(ok(await ana.deal(deal.id)).deal.name).toBe("Website");

  expect(ok(await eve.listCompanies()).companies).toEqual([]);
  expect(ok(await eve.listPeople()).people).toEqual([]);
  expect(ok(await eve.listDeals()).deals).toEqual([]);
  const found = ok(await eve.search({ q: "bea" }));
  expect([found.people, found.companies, found.deals]).toEqual([[], [], []]);
  const looked = ok(await eve.lookup({ addresses: ["BEA@client.test"] }));
  expect([looked.people, looked.companies, looked.deals]).toEqual([[], [], []]);
  const theirs = ok(await eve.addPerson({ name: "Bea", address: "bea@client.test" }));
  expect(theirs.created).toBe(true);
  expect(theirs.person.id).not.toBe(person.id);

  const [anaRow] = await db.select().from(members).where(eq(members.organizationId, acme.id));
  expect(forUser(db, anaRow!.userId).crm).toEqual({});
});

test("a Personal space has no CRM", async () => {
  const person = await createPerson(db, "solo@crm-personal.test");
  const orgId = await ensurePersonalSpace(db, person.id);
  const [member] = await db.select().from(members).where(eq(members.organizationId, orgId));
  const crm = forMember(db, member!.id).crm;

  expect((await crm.listCompanies()).status).toBe("no_crm");
  expect((await crm.stages()).status).toBe("no_crm");
  expect((await crm.addPerson({ name: "Ana", address: "ana@acme.test" })).status).toBe("no_crm");
  expect((await crm.createDeal({ name: "Side gig" })).status).toBe("no_crm");
  expect((await crm.lookup({ addresses: ["ana@acme.test"] })).status).toBe("no_crm");
});

test("removing a member is not blocked by their deals and notes, which stay with no owner", async () => {
  const org = await createOrg(db, "crm-leaver");
  const leaver = await createMember(db, org.id, "leaver");
  const stayer = forMember(db, (await createMember(db, org.id, "stayer")).id).crm;
  const crm = forMember(db, leaver.id).crm;
  const deal = ok(
    await crm.createDeal({ name: "Retainer", valueMinor: 500_00, currency: "EUR" }),
  ).deal;
  expect(deal.ownerMemberId).toBe(leaver.id);
  const note = ok(await crm.createNote({ record: { dealId: deal.id }, body: "Call Tuesday" })).note;

  await db.delete(members).where(eq(members.id, leaver.id));

  const kept = ok(await stayer.deal(deal.id)).deal;
  expect(kept.ownerMemberId).toBeNull();
  expect(kept.createdByMemberId).toBeNull();
  const [noteRow] = await db.select().from(crmNotes).where(eq(crmNotes.id, note.id));
  expect(noteRow!.authorMemberId).toBeNull();
  const events = await db.select().from(crmEvents).where(eq(crmEvents.dealId, deal.id));
  expect(events.map((event) => event.actorMemberId)).toEqual([null]);
  expect((await crm.deal(deal.id)).status).toBe("no_crm");
});

test("deleting for good is for owners and admins, and a member's attempt changes nothing", async () => {
  const org = await createOrg(db, "crm-delete");
  const memberRow = await createMember(db, org.id, "member");
  const adminRow = await createMember(db, org.id, "admin");
  await setRole(db, adminRow.id, "member,admin");
  const member = forMember(db, memberRow.id).crm;
  const admin = forMember(db, adminRow.id).crm;

  const person = ok(await member.addPerson({ name: "Ana", address: "ana@deleted.test" })).person;
  const companyId = person.companyId!;
  const deal = ok(
    await member.createDeal({ name: "Audit", companyId, personIds: [person.id] }),
  ).deal;
  await member.createNote({ record: { dealId: deal.id }, body: "kept until deleted" });

  expect((await member.deleteDeal(deal.id)).status).toBe("forbidden");
  expect((await member.deletePerson(person.id)).status).toBe("forbidden");
  expect((await member.deleteCompany(companyId)).status).toBe("forbidden");
  expect(ok(await member.deal(deal.id)).people.map((p) => p.id)).toEqual([person.id]);

  ok(await member.archiveDeal(deal.id));
  expect(ok(await member.listDeals()).deals).toEqual([]);
  expect(ok(await member.listDeals({ includeArchived: true })).deals.map((d) => d.id)).toEqual([
    deal.id,
  ]);
  expect(ok(await member.deal(deal.id)).deal.archivedAt).not.toBeNull();

  expect((await admin.deleteCompany(companyId)).status).toBe("ok");
  expect(ok(await admin.person(person.id)).person.companyId).toBeNull();
  expect(ok(await admin.deal(deal.id)).deal.companyId).toBeNull();
  expect((await admin.deleteDeal(deal.id)).status).toBe("ok");
  expect(await db.select().from(crmDeals).where(eq(crmDeals.id, deal.id))).toEqual([]);
  expect(await db.select().from(crmNotes).where(eq(crmNotes.dealId, deal.id))).toEqual([]);
  expect(await db.select().from(crmEvents).where(eq(crmEvents.dealId, deal.id))).toEqual([]);
});
