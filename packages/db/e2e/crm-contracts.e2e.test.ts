import { and, eq, like } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { crmCompanies, crmContracts, crmDeals, crmEvents } from "../src/schema/index.ts";
import { addFile, addFolder, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase, untilLockWaiters } from "./support.ts";

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
  const door = forMember(db, ana.id);
  return { crm: door.crm, storage: door.storage };
}

const names = async (storage: ReturnType<typeof forMember>["storage"], parentId: string) =>
  ok(await storage.list({ parentId })).nodes.map((node) => node.name);

const statusEvents = (dealId: string) =>
  db
    .select()
    .from(crmEvents)
    .where(and(eq(crmEvents.dealId, dealId), like(crmEvents.kind, "contract_status%")));

test("two first folder calls to one deal at once make one folder, and a trashed one is replaced", async () => {
  const { crm, storage } = await company("crm-folders");
  const client = ok(await crm.createCompany({ name: "Northwind / EU" })).company;
  const deal = ok(await crm.createDeal({ name: "Website", companyId: client.id })).deal;

  const [first, second] = await Promise.all([crm.dealFolder(deal.id), crm.dealFolder(deal.id)]);
  expect(ok(second).nodeId).toBe(ok(first).nodeId);
  const view = await storage.node(ok(first).nodeId);
  expect(view?.path.map((entry) => entry.name)).toEqual(["Clients", "Northwind - EU", "Website"]);
  const companyFolder = view!.path[1]!.id;
  expect(await names(storage, view!.path[0]!.id)).toEqual(["Northwind - EU"]);
  expect(await names(storage, companyFolder)).toEqual(["Website"]);
  expect(ok(await crm.companyFolder(client.id)).nodeId).toBe(companyFolder);

  ok(await storage.trash(ok(first).nodeId));
  const again = ok(await crm.dealFolder(deal.id));
  expect(again.nodeId).not.toBe(ok(first).nodeId);
  expect(ok(await crm.deal(deal.id)).deal.folderNodeId).toBe(again.nodeId);
  expect(await names(storage, companyFolder)).toEqual(["Website"]);
});

test("marking a contract signed locks its file in the same transaction; a refused lock leaves it unsigned", async () => {
  const { crm, storage } = await company("crm-sign");
  const deal = ok(await crm.createDeal({ name: "Rebrand" })).deal;
  const folder = ok(await crm.dealFolder(deal.id)).nodeId;
  const file = await addFile(storage, { parentId: folder }, "contract.pdf");
  const other = await addFolder(storage, { parentId: folder }, "Drafts");
  const contract = ok(
    await crm.createContract({ title: "MSA", dealId: deal.id, documentNodeId: file.id }),
  ).contract;
  expect(contract).toMatchObject({ status: "draft", companyId: null, dealId: deal.id });

  ok(await storage.trash(file.id));
  expect(await crm.updateContract(contract.id, { status: "signed" })).toEqual({
    status: "invalid_contract",
    param: "documentNodeId",
  });
  expect(
    await crm.updateContract(contract.id, { status: "signed", documentNodeId: other.id }),
  ).toEqual({
    status: "invalid_contract",
    param: "documentNodeId",
  });
  const [row] = await db.select().from(crmContracts).where(eq(crmContracts.id, contract.id));
  expect(row).toMatchObject({ status: "draft", signedAt: null, documentNodeId: file.id });
  expect(await statusEvents(deal.id)).toEqual([]);
  ok(await storage.restore(file.id));
  expect((await storage.node(file.id))?.node.lockedAt).toBeNull();

  const signed = ok(await crm.updateContract(contract.id, { status: "signed" })).contract;
  expect(signed.signedAt).not.toBeNull();
  expect((await storage.node(file.id))?.node.lockedAt).not.toBeNull();
  expect(await storage.trash(file.id)).toEqual({ status: "locked" });
  expect((await statusEvents(deal.id)).map((event) => event.data)).toMatchObject([
    { contractId: contract.id, from: "draft", to: "signed" },
  ]);
});

test("a document moved to My files after it was attached cannot be signed", async () => {
  const { crm, storage } = await company("crm-sign-moved");
  const deal = ok(await crm.createDeal({ name: "Audit" })).deal;
  const folder = ok(await crm.dealFolder(deal.id)).nodeId;
  const file = await addFile(storage, { parentId: folder }, "sow.pdf");
  const contract = ok(
    await crm.createContract({ title: "SOW", dealId: deal.id, documentNodeId: file.id }),
  ).contract;

  ok(await storage.move(file.id, { space: "personal" }));
  expect(await crm.updateContract(contract.id, { status: "signed" })).toEqual({
    status: "invalid_contract",
    param: "documentNodeId",
  });
  const [row] = await db.select().from(crmContracts).where(eq(crmContracts.id, contract.id));
  expect(row).toMatchObject({ status: "draft", signedAt: null });
  expect((await storage.node(file.id))?.node.lockedAt).toBeNull();
  expect(await statusEvents(deal.id)).toEqual([]);
});

test("purging a draft's trashed file leaves the contract without a document", async () => {
  const { crm, storage } = await company("crm-purge");
  const client = ok(await crm.createCompany({ name: "Acme" })).company;
  const folder = ok(await crm.companyFolder(client.id)).nodeId;
  const file = await addFile(storage, { parentId: folder }, "draft.pdf");
  const contract = ok(
    await crm.createContract({ title: "SOW", companyId: client.id, documentNodeId: file.id }),
  ).contract;

  ok(await storage.trash(file.id));
  expect((await storage.deleteForever(file.id)).status).toBe("ok");
  const [row] = await db.select().from(crmContracts).where(eq(crmContracts.id, contract.id));
  expect(row).toMatchObject({ status: "draft", documentNodeId: null });
});

test("a signed contract keeps its status, its document and its row, and outlives its records", async () => {
  const { crm, storage } = await company("crm-signed");
  const client = ok(await crm.createCompany({ name: "Initech" })).company;
  const deal = ok(await crm.createDeal({ name: "Support", companyId: client.id })).deal;
  const folder = ok(await crm.dealFolder(deal.id)).nodeId;
  const executed = await addFile(storage, { parentId: folder }, "executed.pdf");
  const later = await addFile(storage, { parentId: folder }, "v2.pdf");
  const contract = ok(await crm.createContract({ title: "Support", dealId: deal.id })).contract;
  expect(contract.companyId).toBe(client.id);
  ok(await crm.updateContract(contract.id, { status: "sent" }));
  expect(await crm.updateContract(contract.id, { documentNodeId: later.id })).toMatchObject({
    status: "invalid_transition",
  });
  ok(await crm.updateContract(contract.id, { status: "signed", documentNodeId: executed.id }));

  const signed = { status: "contract_signed" };
  expect(await crm.deleteContract(contract.id)).toEqual(signed);
  expect(await crm.updateContract(contract.id, { status: "draft" })).toEqual(signed);
  expect(await crm.updateContract(contract.id, { documentNodeId: later.id })).toEqual(signed);
  expect(await crm.deleteDeal(deal.id)).toEqual(signed);
  expect(await crm.deleteCompany(client.id)).toEqual(signed);

  ok(await crm.updateContract(contract.id, { status: "ended" }));
  expect(await crm.deleteContract(contract.id)).toEqual(signed);
  expect(await crm.deleteDeal(deal.id)).toEqual(signed);
  expect(ok(await crm.listContracts({ companyId: client.id })).contracts).toMatchObject([
    { id: contract.id, status: "ended", documentNodeId: executed.id },
  ]);

  const draftOnly = ok(await crm.createDeal({ name: "Pilot" })).deal;
  ok(await crm.createContract({ title: "Pilot", dealId: draftOnly.id }));
  expect(await crm.deleteDeal(draftOnly.id)).toEqual({ status: "ok" });
});

test("a company deleted while a contract on it is being made and signed keeps both", async () => {
  const org = await createOrg(db, "crm-sign-delete-race");
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  const { crm, storage } = forMember(db, ana.id);
  const client = ok(await crm.createCompany({ name: "Umbrella" })).company;
  const folder = ok(await crm.companyFolder(client.id)).nodeId;
  const file = await addFile(storage, { parentId: folder }, "msa.pdf");

  let deleted: Promise<{ status: string }> | undefined;
  await db.transaction(async (tx) => {
    const inTx = forMember(tx, ana.id).crm;
    const made = ok(
      await inTx.createContract({ title: "MSA", companyId: client.id, documentNodeId: file.id }),
    ).contract;
    ok(await inTx.updateContract(made.id, { status: "signed" }));
    let finished = false;
    deleted = crm.deleteCompany(client.id).finally(() => (finished = true));
    await untilLockWaiters(db, 1, () => finished);
  });
  expect(await deleted).toEqual({ status: "contract_signed" });
  expect(ok(await crm.listContracts({ companyId: client.id })).contracts).toMatchObject([
    { status: "signed", documentNodeId: file.id },
  ]);
});

test("a deal's folder call waits on the company before it holds the deal", async () => {
  const { crm } = await company("crm-folder-lock-order");
  const client = ok(await crm.createCompany({ name: "Initech" })).company;
  const deal = ok(await crm.createDeal({ name: "Rollout", companyId: client.id })).deal;

  let folder: Promise<{ status: string }> | undefined;
  await db.transaction(async (tx) => {
    await tx.select().from(crmCompanies).where(eq(crmCompanies.id, client.id)).for("update");
    let finished = false;
    folder = crm.dealFolder(deal.id).finally(() => (finished = true));
    await untilLockWaiters(db, 1, () => finished);
    const held = await tx
      .select()
      .from(crmDeals)
      .where(eq(crmDeals.id, deal.id))
      .for("update", { noWait: true });
    expect(held).toHaveLength(1);
  });
  expect((await folder)?.status).toBe("ok");
});
