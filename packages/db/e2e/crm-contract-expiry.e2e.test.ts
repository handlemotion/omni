import { and, eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { endExpiredContracts } from "../src/crm.ts";
import { forMember } from "../src/for-member.ts";
import { crmContracts, crmEvents } from "../src/schema/index.ts";
import { addFile, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function workspace(slug: string) {
  const org = await createOrg(db, slug);
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  const { crm, storage } = forMember(db, ana.id);
  const deal = ok(await crm.createDeal({ name: "Retainer" })).deal;
  const folder = ok(await crm.dealFolder(deal.id)).nodeId;
  let files = 0;
  async function contract(status: "draft" | "sent" | "signed", expiresOn: string | null) {
    const file = await addFile(storage, { parentId: folder }, `contract-${++files}.pdf`);
    const made = ok(
      await crm.createContract({
        title: `Contract ${files}`,
        dealId: deal.id,
        documentNodeId: file.id,
        expiresOn,
      }),
    ).contract;
    if (status !== "draft") ok(await crm.updateContract(made.id, { status }));
    return made.id;
  }
  return { org, deal, contract };
}

const statusOf = async (id: string) =>
  (await db.select().from(crmContracts).where(eq(crmContracts.id, id)))[0]?.status;

const endedEvents = async (orgId: string, contractId: string) =>
  (
    await db
      .select()
      .from(crmEvents)
      .where(and(eq(crmEvents.orgId, orgId), eq(crmEvents.kind, "contract_status_changed")))
  ).filter((event) => event.data.contractId === contractId && event.data.to === "ended");

const NOW = new Date("2026-11-16T00:30:00Z");

test("an expired signed contract ends once, with one keyed event, and a second run writes nothing", async () => {
  const { org, deal, contract } = await workspace("expiry-once");
  const id = await contract("signed", "2026-11-15");

  const first = await endExpiredContracts(db, { now: NOW });
  expect(first.ended).toContainEqual({ orgId: org.id, contractId: id });
  expect(await statusOf(id)).toBe("ended");
  const events = await endedEvents(org.id, id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    dealId: deal.id,
    actorMemberId: null,
    dedupeKey: `contract_ended:${id}`,
    data: { contractId: id, from: "signed", to: "ended" },
  });

  const second = await endExpiredContracts(db, { now: NOW });
  expect(second.ended.map((row) => row.contractId)).not.toContain(id);
  expect(await endedEvents(org.id, id)).toHaveLength(1);
});

test("drafts, sent contracts, and signed ones not yet expired are left as they are", async () => {
  const { contract } = await workspace("expiry-untouched");
  const draft = await contract("draft", "2026-01-01");
  const sent = await contract("sent", "2026-01-01");
  const today = await contract("signed", "2026-11-16");
  const later = await contract("signed", "2027-01-01");
  const open = await contract("signed", null);

  const run = await endExpiredContracts(db, { now: NOW });
  const ended = run.ended.map((row) => row.contractId);
  for (const id of [draft, sent, today, later, open]) expect(ended).not.toContain(id);
  expect(await statusOf(draft)).toBe("draft");
  expect(await statusOf(sent)).toBe("sent");
  for (const id of [today, later, open]) expect(await statusOf(id)).toBe("signed");
});

test("a run ends at most its limit and says more are left", async () => {
  const { contract } = await workspace("expiry-batches");
  const ids = [
    await contract("signed", "2025-01-01"),
    await contract("signed", "2025-01-02"),
    await contract("signed", "2025-01-03"),
  ];
  const first = await endExpiredContracts(db, { now: NOW, limit: 1 });
  expect(first.ended).toHaveLength(1);
  expect(first.more).toBe(true);
  for (let run = 0; run < 10; run++) {
    if (!(await endExpiredContracts(db, { now: NOW, limit: 1 })).more) break;
  }
  for (const id of ids) expect(await statusOf(id)).toBe("ended");
});
