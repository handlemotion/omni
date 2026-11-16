// Deals, the pipeline and its stage rules (ADR 0036 decision 2).
import { and, eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { crmEvents, crmStages } from "../src/schema/index.ts";
import { setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function company(slug: string) {
  const org = await createOrg(db, slug);
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  return { org, crm: forMember(db, ana.id).crm };
}

const stageMoves = (dealId: string) =>
  db
    .select()
    .from(crmEvents)
    .where(and(eq(crmEvents.dealId, dealId), eq(crmEvents.kind, "stage_moved")));

test("moving a deal to Won twice sets won_at once and writes one event", async () => {
  const { crm } = await company("crm-won");
  const stages = ok(await crm.stages()).stages;
  const byName = (name: string) => stages.find((stage) => stage.name === name)!;
  const deal = ok(await crm.createDeal({ name: "Rebrand" })).deal;
  expect([deal.stageId, deal.wonAt, deal.closedAt]).toEqual([byName("Lead").id, null, null]);

  // At once, as two members dragging the same card would.
  await Promise.all([
    crm.updateDeal(deal.id, { stageId: byName("Won").id }),
    crm.updateDeal(deal.id, { stageId: byName("Won").id }),
  ]);
  const won = ok(await crm.deal(deal.id)).deal;
  expect(won.wonAt).not.toBeNull();
  expect(won.stageKind).toBe("won");
  expect(await stageMoves(deal.id)).toHaveLength(1);

  // A bulk move to the same stage is a repeat too.
  expect(ok(await crm.moveDeals({ dealIds: [deal.id], stageId: byName("Won").id })).moved).toEqual(
    [],
  );
  // Delivered closes it; reopening clears that and keeps the first won date.
  const done = ok(await crm.updateDeal(deal.id, { stageId: byName("Delivered").id })).deal;
  expect(done.closedAt).not.toBeNull();
  const reopened = ok(await crm.updateDeal(deal.id, { stageId: byName("Lead").id })).deal;
  expect(reopened.closedAt).toBeNull();
  const wonAgain = ok(await crm.updateDeal(deal.id, { stageId: byName("Won").id })).deal;
  expect(wonAgain.wonAt).toEqual(won.wonAt);
  expect(await stageMoves(deal.id)).toHaveLength(4);

  // A job that names its move writes it once however often it runs.
  const lost = byName("Lost").id;
  ok(await crm.updateDeal(deal.id, { stageId: lost, dedupeKey: "job-1" }));
  ok(await crm.updateDeal(deal.id, { stageId: byName("Lead").id, dedupeKey: "job-1" }));
  expect(ok(await crm.deal(deal.id)).deal.stageId).toBe(lost);
});

test("a bulk move that names a missing deal moves none of them", async () => {
  const { crm } = await company("crm-bulk-missing");
  const won = ok(await crm.stages()).stages.find((stage) => stage.name === "Won")!;
  const deal = ok(await crm.createDeal({ name: "Kept in Lead" })).deal;
  // Sorts after every real UUIDv7, so the real deal comes first in the move order.
  const missing = "ffffffff-ffff-7fff-bfff-ffffffffffff";

  expect((await crm.moveDeals({ dealIds: [deal.id, missing], stageId: won.id })).status).toBe(
    "not_found",
  );
  const after = ok(await crm.deal(deal.id)).deal;
  expect([after.stageId, after.wonAt]).toEqual([deal.stageId, null]);
  expect(await stageMoves(deal.id)).toHaveLength(0);
});

test("a value takes the workspace's last currency, and a bad currency is refused", async () => {
  const { crm } = await company("crm-currency");
  expect((await crm.createDeal({ name: "No currency yet", valueMinor: 100 })).status).toBe(
    "invalid_currency",
  );
  expect(
    (await crm.createDeal({ name: "Lowercase", valueMinor: 100, currency: "eur" })).status,
  ).toBe("invalid_currency");
  ok(await crm.createDeal({ name: "First", valueMinor: 100, currency: "EUR" }));
  expect(ok(await crm.settings()).settings.defaultCurrency).toBe("EUR");
  const second = ok(await crm.createDeal({ name: "Second", valueMinor: 250 })).deal;
  expect([second.valueMinor, second.valueCurrency]).toEqual([250, "EUR"]);
  expect((await crm.putSettings({ defaultCurrency: "EURO" })).status).toBe("invalid_currency");
});

test("replacing stages refuses to drop a stage holding deals or to leave a kind without one", async () => {
  const { crm, org } = await company("crm-stages");
  const stages = ok(await crm.stages()).stages;
  const [lead, progress, won, delivered, lost] = stages;
  const deal = ok(await crm.createDeal({ name: "Held", stageId: progress!.id })).deal;
  await crm.archiveDeal(deal.id);

  // An archived deal still holds its stage.
  const withoutProgress = [lead!, won!, delivered!, lost!].map(({ id, name }) => ({ id, name }));
  expect(await crm.replaceStages(withoutProgress)).toEqual({
    status: "stage_in_use",
    stageIds: [progress!.id],
  });
  const withoutLost = [lead!, progress!, won!, delivered!].map(({ id, name }) => ({ id, name }));
  expect(await crm.replaceStages(withoutLost)).toEqual({
    status: "stage_kind_required",
    kinds: ["lost"],
  });
  const unchanged = await db.select().from(crmStages).where(eq(crmStages.orgId, org.id));
  expect(unchanged).toHaveLength(5);

  // Rename, reorder, add and remove an empty stage, in one replace.
  const replaced = ok(
    await crm.replaceStages([
      { id: progress!.id, name: "Doing" },
      { name: "Proposal", kind: "open" },
      { id: won!.id, name: "Won" },
      { id: delivered!.id, name: "Delivered" },
      { id: lost!.id, name: "Lost" },
    ]),
  ).stages;
  expect(replaced.map((s) => [s.name, s.kind])).toEqual([
    ["Doing", "open"],
    ["Proposal", "open"],
    ["Won", "won"],
    ["Delivered", "done"],
    ["Lost", "lost"],
  ]);

  // Only owners and admins edit stages.
  const member = forMember(db, (await createMember(db, org.id, "ben")).id).crm;
  expect((await member.replaceStages(replaced.map(({ id, name }) => ({ id, name })))).status).toBe(
    "forbidden",
  );
});

test("a note is edited and deleted only by its author, and the timeline pages newest first", async () => {
  const { crm, org } = await company("crm-notes");
  const ben = forMember(db, (await createMember(db, org.id, "ben")).id).crm;
  const deal = ok(await crm.createDeal({ name: "Timeline" })).deal;
  const notes = [];
  for (const body of ["one", "two", "three"]) {
    notes.push(ok(await crm.createNote({ record: { dealId: deal.id }, body })).note);
  }
  expect((await ben.updateNote(notes[0]!.id, { body: "mine" })).status).toBe("forbidden");
  expect((await ben.deleteNote(notes[0]!.id)).status).toBe("forbidden");

  const first = ok(await ben.notes({ dealId: deal.id }, { limit: 2 }));
  expect(first.items.map((n) => n.body)).toEqual(["three", "two"]);
  const second = ok(await ben.notes({ dealId: deal.id }, { cursor: first.nextCursor, limit: 2 }));
  expect(second.items.map((n) => n.body)).toEqual(["one"]);
  expect(second.nextCursor).toBeNull();
});
