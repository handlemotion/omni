import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";
import { CookieJar, justMe, signIn } from "./support.ts";

let stack: CrmStack;

beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

test("crm.changed reaches a teammate's socket, no socket of another workspace, and no removed member", async () => {
  const acme = await stack.company("acme");
  const beta = await stack.company("beta");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);
  const dan = await stack.member(acme.id);
  const cid = await stack.member(beta.id);
  const beaSocket = await stack.socket(bea.jar);
  const danSocket = await stack.socket(dan.jar);
  const cidSocket = await stack.socket(cid.jar);
  await stack.db.delete(schema.members).where(eq(schema.members.id, dan.id));

  const made = await stack.api(ana.jar, "POST", "/companies", { name: "Initech" });
  expect(made.status).toBe(201);
  const event = await beaSocket.waitFor((e) => e.type === "crm.changed");
  expect(event).toEqual({ type: "crm.changed", kind: "company", ids: [made.body.company.id] });
  const theirs = await stack.api(cid.jar, "POST", "/companies", { name: "Hooli" });
  await cidSocket.waitFor((e) => e.type === "crm.changed");
  expect(cidSocket.received.filter((e) => e.type === "crm.changed")).toEqual([
    { type: "crm.changed", kind: "company", ids: [theirs.body.company.id] },
  ]);
  expect(danSocket.received.filter((e) => e.type === "crm.changed")).toEqual([]);
  beaSocket.close();
  danSocket.close();
  cidSocket.close();
});

test("replacing the stages tells a teammate's socket", async () => {
  const acme = await stack.company("acme");
  const owner = await stack.member(acme.id, "owner");
  const bea = await stack.member(acme.id);
  const beaSocket = await stack.socket(bea.jar);

  const listed = await stack.api(owner.jar, "GET", "/stages");
  const stages = listed.body.stages as { id: string; name: string }[];
  const renamed = stages.map((stage, i) => ({
    id: stage.id,
    name: i === 0 ? "Prospect" : stage.name,
  }));
  const put = await stack.api(owner.jar, "PUT", "/stages", { stages: renamed });
  expect(put.status).toBe(200);
  const event = await beaSocket.waitFor((e) => e.type === "crm.changed");
  expect(event).toEqual({ type: "crm.changed", kind: "stages", ids: stages.map((s) => s.id) });
  beaSocket.close();
});

test("lookup finds a person by an address in any letter case, and nothing from another workspace", async () => {
  const acme = await stack.company("acme-lookup");
  const beta = await stack.company("beta-lookup");
  const ana = await stack.member(acme.id);
  const cid = await stack.member(beta.id);
  const carla = (
    await stack.api(ana.jar, "POST", "/people", { name: "Carla", address: "carla@northwind.com" })
  ).body.person;
  const deal = (
    await stack.api(ana.jar, "POST", "/deals", { name: "Website", personIds: [carla.id] })
  ).body.deal;
  const dora = (
    await stack.api(cid.jar, "POST", "/people", { name: "Dora", address: "dora@initech.com" })
  ).body.person;

  const found = await stack.api(
    ana.jar,
    "GET",
    `/lookup?address=${encodeURIComponent("CARLA@Northwind.COM,Dora@initech.com")}`,
  );
  expect(found.status).toBe(200);
  expect(found.body.people.map((p: { id: string }) => p.id)).toEqual([carla.id]);
  expect(found.body.companies.map((c: { id: string }) => c.id)).toEqual([carla.companyId]);
  expect(found.body.deals.map((d: { id: string }) => d.id)).toEqual([deal.id]);

  const theirs = await stack.api(
    cid.jar,
    "GET",
    "/lookup?address=carla%40northwind.com&address=DORA%40INITECH.COM",
  );
  expect(theirs.body.people.map((p: { id: string }) => p.id)).toEqual([dora.id]);
  expect(theirs.body.deals).toEqual([]);
});

test("adding an address twice answers the same person; giving it to someone else answers 409 with who holds it", async () => {
  const org = await stack.company("add-once");
  const ana = await stack.member(org.id);
  const first = await stack.api(ana.jar, "POST", "/people", {
    name: "Carla",
    address: "carla@northwind.com",
  });
  expect(first.status).toBe(201);
  const again = await stack.api(ana.jar, "POST", "/people", {
    name: "Carla N.",
    address: "Carla@Northwind.com",
  });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({
    created: false,
    person: { id: first.body.person.id, name: "Carla" },
  });

  const other = (
    await stack.api(ana.jar, "POST", "/people", { name: "Dan", address: "dan@northwind.com" })
  ).body.person;
  const taken = await stack.api(ana.jar, "PATCH", `/people/${other.id}`, {
    addresses: { add: ["carla@northwind.com"] },
  });
  expect(taken.status).toBe(409);
  expect(taken.body).toMatchObject({
    code: "ADDRESS_TAKEN",
    address: "carla@northwind.com",
    personId: first.body.person.id,
  });
});

test("a Personal space answers 404 no_crm", async () => {
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, "solo@personal.test", jar);
  await justMe(stack.worker, jar);
  const listed = await stack.api(jar, "GET", "/companies");
  expect(listed.status).toBe(404);
  expect(listed.body).toMatchObject({ code: "NO_CRM" });
});
