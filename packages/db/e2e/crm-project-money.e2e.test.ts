import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { members } from "../src/schema/index.ts";
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
  return forMember(db, member!.id).crm;
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
  const fran = await freelancer(org.id, franAt);
  const gus = await freelancer(org.id, gusAt);
  return { team: team.crm, website, app, fran, gus, client: `bea@${slug}-client.test` };
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

  expect((await fran.listContracts({ dealId: website.id })).status).toBe("not_found");
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
