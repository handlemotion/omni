import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { settleSentContracts } from "../src/crm.ts";
import { forMember } from "../src/for-member.ts";
import {
  crmContracts,
  members,
  storageNodes,
  storageSignatureRequests,
  userEmails,
} from "../src/schema/index.ts";
import { addFile, createPerson, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function freelancer(orgId: string, email: string) {
  const user = await createPerson(db, email);
  const [member] = await db
    .insert(members)
    .values({
      id: randomUUID(),
      organizationId: orgId,
      userId: user.id,
      role: "freelancer",
      createdAt: new Date(),
    })
    .returning();
  return { id: member!.id, ...forMember(db, member!.id) };
}

async function studio(slug: string) {
  const org = await createOrg(db, slug);
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  const team = forMember(db, ana.id);
  const person = ok(await team.crm.addPerson({ name: "Bea", address: `bea@${slug}-client.test` }));
  const deal = async (name: string, valueMinor: number) =>
    ok(
      await team.crm.createDeal({
        name,
        valueMinor,
        currency: "USD",
        personIds: [person.person.id],
      }),
    ).deal;
  const website = await deal("website", 1_200_000);
  const app = await deal("app", 4_800_000);
  ok(await team.crm.updateDeal(website.id, { valueMinor: 1_500_000 }));
  const folder = ok(await team.crm.dealFolder(website.id)).nodeId;
  const pdf = await addFile(team.storage, { parentId: folder }, "msa.pdf");
  ok(await team.crm.createContract({ title: "MSA", dealId: website.id, documentNodeId: pdf.id }));
  ok(await team.crm.createNote({ record: { dealId: website.id }, body: "Budget is 15k, firm" }));
  const [franAt, gusAt] = [`fran@${slug}.test`, `gus@${slug}.test`];
  for (const project of [website, app]) {
    ok(
      await team.crm.grantProjectAccess(project.id, {
        email: franAt,
        scope: "freelancer",
      }),
    );
    ok(
      await team.crm.grantProjectAccess(project.id, {
        email: gusAt,
        scope: "freelancer",
      }),
    );
  }
  const franDoor = await freelancer(org.id, franAt);
  const gusDoor = await freelancer(org.id, gusAt);
  return {
    org,
    teamDoor: team,
    team: team.crm,
    website,
    app,
    folder,
    pdf,
    fran: franDoor.crm,
    gus: gusDoor.crm,
    franDoor,
    gusDoor,
    client: `bea@${slug}-client.test`,
  };
}

const noValue = { valueMinor: null, valueCurrency: null };

test("a freelancer never reads what a project is worth, by any route", async () => {
  const { team, website, app, fran, client } = await studio("money-value");

  expect(ok(await fran.deal(website.id)).deal).toMatchObject({ name: "website", ...noValue });
  const listed = ok(await fran.listDeals()).deals;
  expect(listed.map((d) => d.name)).toEqual(["app", "website"]);
  for (const d of listed) expect(d).toMatchObject(noValue);
  const found = ok(await fran.search({ q: "web" })).deals;
  expect(found).toMatchObject([{ name: "website", ...noValue }]);
  const looked = ok(await fran.lookup({ addresses: [client] })).deals;
  expect(looked).toHaveLength(2);
  for (const d of looked) expect(d).toMatchObject(noValue);

  expect(ok(await fran.listDeals({ minValue: 2_000_000 })).deals).toHaveLength(2);
  expect(ok(await fran.listDeals({ maxValue: 1 })).deals).toHaveLength(2);
  const byValue = ok(await fran.listDeals({ sort: { key: "value", dir: "desc" }, limit: 1 }));
  expect(byValue.deals.map((d) => d.name)).toEqual(["app"]);
  expect(byValue.nextCursor).toMatchObject({ key: "name", value: "app" });
  const next = ok(
    await fran.listDeals({
      sort: { key: "value", dir: "desc" },
      limit: 1,
      cursor: byValue.nextCursor ?? undefined,
    }),
  );
  expect(next.deals.map((d) => d.name)).toEqual(["website"]);

  expect(ok(await team.deal(app.id)).deal).toMatchObject({
    valueMinor: 4_800_000,
    valueCurrency: "USD",
  });
  expect(ok(await team.listDeals({ minValue: 2_000_000 })).deals.map((d) => d.name)).toEqual([
    "app",
  ]);
});

test("contracts, their events and the team's notes stay with the team", async () => {
  const { team, website, fran, gus } = await studio("money-records");

  expect(ok(await fran.listContracts({ dealId: website.id })).contracts).toEqual([]);
  const events = ok(await fran.events({ dealId: website.id })).items.map((e) => e.kind);
  expect(events).toContain("created");
  expect(events.filter((kind) => kind.startsWith("contract_") || kind === "value_changed")).toEqual(
    [],
  );
  const teamEvents = ok(await team.events({ dealId: website.id })).items.map((e) => e.kind);
  expect(teamEvents).toContain("contract_created");

  expect(ok(await fran.notes({ dealId: website.id })).items).toEqual([]);
  ok(await fran.createNote({ record: { dealId: website.id }, body: "Fonts are licensed" }));
  const bodies = async (crm: typeof fran) =>
    ok(await crm.notes({ dealId: website.id })).items.map((n) => n.body);
  expect(await bodies(fran)).toEqual(["Fonts are licensed"]);
  expect(await bodies(gus)).toEqual(["Fonts are licensed"]);
  expect(await bodies(team)).toEqual(["Fonts are licensed", "Budget is 15k, firm"]);
});

test("contract files go into the project's Admin folder, which no freelancer reaches", async () => {
  const { teamDoor, website, folder, pdf, franDoor } = await studio("money-admin");
  const brief = await addFile(teamDoor.storage, { parentId: folder }, "brief.pdf");

  const inFolder = ok(await teamDoor.storage.list({ parentId: folder })).nodes;
  const admin = inFolder.find((node) => node.name === "Admin")!;
  expect(admin).toMatchObject({ kind: "folder", teamOnly: true });
  expect((await teamDoor.storage.node(pdf.id))?.path.at(-2)).toMatchObject({ name: "Admin" });

  const theirs = ok(await franDoor.storage.list({ parentId: folder })).nodes.map((n) => n.name);
  expect(theirs).toEqual(["brief.pdf"]);
  expect(await franDoor.storage.node(admin.id)).toBeNull();
  expect(await franDoor.storage.node(pdf.id)).toBeNull();
  expect((await franDoor.storage.node(brief.id))?.role).toBe("editor");
  expect((await franDoor.storage.archive([folder], 100)).status).toBe("ok");
  const zipped = ok(await franDoor.storage.archive([folder], 100)).entries.map((e) => e.path);
  expect(zipped.toSorted()).toEqual(["website", "website/brief.pdf"]);
  expect((await franDoor.storage.move(brief.id, { parentId: admin.id })).status).toBe("not_found");
  expect(ok(await franDoor.crm.dealFolder(website.id)).nodeId).toBe(folder);
});

test("a freelancer sees and opens only the contracts that involve them", async () => {
  const { team, website, pdf, fran, gus, franDoor, gusDoor } = await studio("money-people");
  const [contract] = ok(await team.listContracts({ dealId: website.id })).contracts;

  const involved = ok(await team.updateContract(contract!.id, { memberIds: [franDoor.id] }));
  expect(involved.contract.memberIds).toEqual([franDoor.id]);
  const seen = ok(await fran.listContracts({ dealId: website.id })).contracts;
  expect(seen.map((c) => [c.title, c.memberIds])).toEqual([["MSA", [franDoor.id]]]);
  expect((await franDoor.storage.node(pdf.id))?.role).toBe("viewer");
  expect(ok(await gus.listContracts({ dealId: website.id })).contracts).toEqual([]);
  expect(await gusDoor.storage.node(pdf.id)).toBeNull();

  const strangers = await team.updateContract(contract!.id, { memberIds: [randomUUID()] });
  expect(strangers).toMatchObject({ status: "invalid_contract", param: "memberIds" });

  ok(await team.updateContract(contract!.id, { memberIds: [] }));
  expect(ok(await fran.listContracts({ dealId: website.id })).contracts).toEqual([]);
  expect(await franDoor.storage.node(pdf.id)).toBeNull();
});

test("a freelancer swapped off a contract with its file keeps neither file", async () => {
  const { teamDoor, team, website, folder, pdf, franDoor, gusDoor } = await studio("money-swap");
  const [contract] = ok(await team.listContracts({ dealId: website.id })).contracts;
  ok(await team.updateContract(contract!.id, { memberIds: [franDoor.id] }));
  expect((await franDoor.storage.node(pdf.id))?.role).toBe("viewer");

  const sow = await addFile(teamDoor.storage, { parentId: folder }, "sow.pdf");
  ok(await team.updateContract(contract!.id, { memberIds: [gusDoor.id], documentNodeId: sow.id }));
  expect(await franDoor.storage.node(pdf.id)).toBeNull();
  expect(await franDoor.storage.node(sow.id)).toBeNull();
  expect((await gusDoor.storage.node(sow.id))?.role).toBe("viewer");
});

test("taking a freelancer off a project takes their contracts' files too", async () => {
  const { team, website, pdf, franDoor } = await studio("money-revoke");
  const franAt = "fran@money-revoke.test";
  const [contract] = ok(await team.listContracts({ dealId: website.id })).contracts;
  ok(await team.updateContract(contract!.id, { memberIds: [franDoor.id] }));
  expect((await franDoor.storage.node(pdf.id))?.role).toBe("viewer");

  ok(await team.revokeProjectAccess(website.id, franAt));
  expect(await franDoor.storage.node(pdf.id)).toBeNull();
  ok(await team.updateContract(contract!.id, { title: "MSA v2" }));
  expect(await franDoor.storage.node(pdf.id)).toBeNull();

  ok(await team.grantProjectAccess(website.id, { email: franAt, scope: "freelancer" }));
  expect((await franDoor.storage.node(pdf.id))?.role).toBe("viewer");
  ok(await team.grantProjectAccess(website.id, { email: franAt, scope: "client" }));
  expect(await franDoor.storage.node(pdf.id)).toBeNull();
});

test("a signed copy reaches the freelancer after its sender left the team", async () => {
  const { org, teamDoor, team, website, folder, pdf, franDoor } = await studio("money-sealed");
  const [contract] = ok(await team.listContracts({ dealId: website.id })).contracts;
  ok(await team.updateContract(contract!.id, { memberIds: [franDoor.id] }));
  const admin = ok(await teamDoor.storage.list({ parentId: folder })).nodes.find(
    (node) => node.name === "Admin",
  )!;
  const sealed = await addFile(teamDoor.storage, { parentId: admin.id }, "msa-signed.pdf");
  const [request] = await db
    .insert(storageSignatureRequests)
    .values({
      orgId: org.id,
      nodeId: pdf.id,
      contentVersion: 1,
      documentSha256: "0".repeat(64),
      status: "completed",
      completedAt: new Date(),
      sealedNodeId: sealed.id,
    })
    .returning();
  await db
    .update(crmContracts)
    .set({ status: "sent", signatureRequestId: request!.id, createdByMemberId: null })
    .where(eq(crmContracts.id, contract!.id));

  const { settled } = await settleSentContracts(db);
  expect(settled).toContainEqual({ orgId: org.id, contractId: contract!.id, status: "signed" });
  expect((await franDoor.storage.node(sealed.id))?.role).toBe("viewer");
});

test("a freelancer on a project at a second address still opens their contract", async () => {
  const { org, teamDoor, team, website, folder, pdf } = await studio("money-alias");
  const iris = await freelancer(org.id, "iris@money-alias.test");
  const [row] = await db.select().from(members).where(eq(members.id, iris.id));
  await db.insert(userEmails).values({
    userId: row!.userId,
    email: "iris@studio-alias.test",
    verifiedAt: new Date(),
  });
  ok(
    await team.grantProjectAccess(website.id, {
      email: "iris@studio-alias.test",
      scope: "freelancer",
    }),
  );
  const [contract] = ok(await team.listContracts({ dealId: website.id })).contracts;
  ok(await team.updateContract(contract!.id, { memberIds: [iris.id] }));
  expect((await iris.storage.node(pdf.id))?.role).toBe("viewer");

  ok(await teamDoor.storage.putGrant(pdf.id, "iris@money-alias.test", "viewer"));
  const sow = await addFile(teamDoor.storage, { parentId: folder }, "sow.pdf");
  ok(await team.updateContract(contract!.id, { documentNodeId: sow.id }));
  expect(await iris.storage.node(pdf.id)).toBeNull();
  expect((await iris.storage.node(sow.id))?.role).toBe("viewer");

  ok(await team.revokeProjectAccess(website.id, "iris@studio-alias.test"));
  expect(await iris.storage.node(sow.id)).toBeNull();
});

test("leaving one project keeps a file another project's contract still gives", async () => {
  const { team, website, app, pdf, franDoor } = await studio("money-shared-file");
  const [msa] = ok(await team.listContracts({ dealId: website.id })).contracts;
  ok(await team.updateContract(msa!.id, { memberIds: [franDoor.id] }));
  ok(
    await team.createContract({
      title: "MSA, app",
      dealId: app.id,
      documentNodeId: pdf.id,
      memberIds: [franDoor.id],
    }),
  );

  ok(await team.revokeProjectAccess(website.id, "fran@money-shared-file.test"));
  expect((await franDoor.storage.node(pdf.id))?.role).toBe("viewer");
  ok(await team.revokeProjectAccess(app.id, "fran@money-shared-file.test"));
  expect(await franDoor.storage.node(pdf.id)).toBeNull();
});

test("a locked contract filed before the Admin folder is filed when a freelancer joins", async () => {
  const { org, teamDoor, team, website, folder, pdf } = await studio("money-locked");
  ok(await teamDoor.storage.lock(pdf.id));
  await db.update(storageNodes).set({ parentId: folder }).where(eq(storageNodes.id, pdf.id));
  const halAt = "hal@money-locked.test";
  ok(await team.grantProjectAccess(website.id, { email: halAt, scope: "freelancer" }));
  const hal = await freelancer(org.id, halAt);

  const filed = await teamDoor.storage.node(pdf.id);
  expect(filed?.path.at(-2)).toMatchObject({ name: "Admin" });
  expect(filed?.node.lockedAt).not.toBeNull();
  expect(await hal.storage.node(pdf.id)).toBeNull();
});
