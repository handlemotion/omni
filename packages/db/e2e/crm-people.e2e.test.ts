import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { crmCompanies, crmPeople, crmPersonEmails } from "../src/schema/index.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

test("two adds of one address at the same moment make one person and one company", async () => {
  const org = await createOrg(db, "crm-race");
  const ana = forMember(db, (await createMember(db, org.id, "ana")).id).crm;
  const ben = forMember(db, (await createMember(db, org.id, "ben")).id).crm;

  const results = await Promise.all([
    ana.addPerson({ name: "Carla", address: "carla@globex.test" }),
    ben.addPerson({ name: "Carla G", address: "Carla@Globex.test" }),
    ana.addPerson({ name: "Carla", address: "carla@globex.test" }),
  ]);

  const people = results.map((result) => ok(result));
  expect(new Set(people.map((r) => r.person.id)).size).toBe(1);
  expect(people.filter((r) => r.created)).toHaveLength(1);
  expect(await db.select().from(crmPeople).where(eq(crmPeople.orgId, org.id))).toHaveLength(1);
  expect(await db.select().from(crmCompanies).where(eq(crmCompanies.orgId, org.id))).toHaveLength(
    1,
  );
});

test("ana@acme.com makes Acme with acme.com, bea@acme.com joins it, x@gmail.com makes no company", async () => {
  const org = await createOrg(db, "crm-domains");
  const crm = forMember(db, (await createMember(db, org.id, "ana")).id).crm;

  const ana = ok(await crm.addPerson({ name: "Ana", address: "ana@acme.com" })).person;
  const acme = ok(await crm.company(ana.companyId!));
  expect(acme.company.name).toBe("Acme");
  expect(acme.domains).toEqual(["acme.com"]);

  const bea = ok(await crm.addPerson({ name: "Bea", address: "BEA@Acme.com" })).person;
  expect(bea.companyId).toBe(ana.companyId);
  expect(bea.addresses).toEqual([{ address: "bea@acme.com", isPrimary: true }]);
  expect(ok(await crm.company(acme.company.id)).people.map((p) => p.name)).toEqual(["Ana", "Bea"]);

  const x = ok(await crm.addPerson({ name: "X", address: "x@gmail.com" })).person;
  expect(x.companyId).toBeNull();
  expect(ok(await crm.listCompanies()).companies.map((c) => c.name)).toEqual(["Acme"]);

  const again = ok(await crm.addPerson({ name: "Someone else", address: "Ana@ACME.com" }));
  expect([again.created, again.person.id, again.person.name]).toEqual([false, ana.id, "Ana"]);

  const other = ok(await crm.createCompany({ name: "Other" })).company;
  expect((await crm.addCompanyDomain(other.id, "gmail.com")).status).toBe("webmail_domain");
  expect(await crm.addCompanyDomain(other.id, "ACME.com.")).toEqual({
    status: "domain_taken",
    companyId: acme.company.id,
  });
  expect((await crm.createCompany({ name: "Dup", domains: ["new.test", "acme.com"] })).status).toBe(
    "domain_taken",
  );
  expect(ok(await crm.listCompanies({ q: "dup" })).companies).toEqual([]);
  expect(ok(await crm.addCompanyDomain(other.id, "new.test")).domains).toEqual(["new.test"]);
});

test("an address another person holds is refused and the person is left as they were", async () => {
  const org = await createOrg(db, "crm-addresses");
  const crm = forMember(db, (await createMember(db, org.id, "ana")).id).crm;
  const ana = ok(await crm.addPerson({ name: "Ana", address: "ana@initech.test" })).person;
  const bob = ok(await crm.addPerson({ name: "Bob", address: "bob@initech.test" })).person;

  const refused = await crm.updatePerson(bob.id, {
    name: "Robert",
    addresses: { add: ["robert@initech.test", "ANA@initech.test"] },
  });
  expect(refused).toEqual({
    status: "address_taken",
    address: "ana@initech.test",
    personId: ana.id,
  });
  const unchanged = ok(await crm.person(bob.id)).person;
  expect(unchanged.name).toBe("Bob");
  expect(unchanged.addresses.map((a) => a.address)).toEqual(["bob@initech.test"]);

  const moved = ok(
    await crm.updatePerson(bob.id, {
      addresses: { add: ["robert@initech.test"], remove: ["bob@initech.test"] },
    }),
  ).person;
  expect(moved.addresses).toEqual([{ address: "robert@initech.test", isPrimary: true }]);
  const rows = await db.select().from(crmPersonEmails).where(eq(crmPersonEmails.personId, bob.id));
  expect(rows.map((row) => row.address)).toEqual(["robert@initech.test"]);

  ok(await crm.addPerson({ name: "New Bob", address: "bob@initech.test" }));
  const looked = ok(await crm.lookup({ addresses: ["Robert@Initech.test"] }));
  expect(looked.people.map((p) => p.name)).toEqual(["Bob"]);
});
