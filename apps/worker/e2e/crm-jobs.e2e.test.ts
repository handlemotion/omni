// The CRM's daily job (`src/crm/jobs.ts`, registered on the crm module in `src/modules.ts`) run
// through the real Worker's daily cron under workerd, against Postgres (ADR 0039 decision 4).
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";

const DAILY_CRON = "47 3 * * *";

let stack: CrmStack;

beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

const daily = async () =>
  (await stack.worker.server.getWorker().scheduled({ cron: DAILY_CRON })).outcome;

// Catches: the daily cron not running the CRM's job (the module never registered, or its Effect
// program failing under workerd), teammates never told the contract ended, and a second run
// writing the end again.
test("the daily cron ends an expired signed contract once and tells the workspace", async () => {
  const acme = await stack.company("acme-expiry");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);
  const client = await stack.api(ana.jar, "POST", "/companies", { name: "Initech" });
  expect(client.status).toBe(201);
  const companyId: string = client.body.company.id;
  // Signed last year and over yesterday, as a member would have left it.
  const [contract] = await stack.db
    .insert(schema.crmContracts)
    .values({
      orgId: acme.id,
      companyId,
      title: "Support plan",
      status: "signed",
      signedAt: new Date("2025-11-01T00:00:00Z"),
      expiresOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    })
    .returning();
  const beaSocket = await stack.socket(bea.jar);

  expect(await daily()).toBe("ok");
  const announced = await beaSocket.waitFor(
    (e) => e.type === "crm.changed" && e.kind === "contract",
  );
  expect(announced).toEqual({ type: "crm.changed", kind: "contract", ids: [contract!.id] });
  const listed = await stack.api(ana.jar, "GET", `/contracts?company=${companyId}`);
  expect(listed.body.contracts).toMatchObject([{ id: contract!.id, status: "ended" }]);

  expect(await daily()).toBe("ok");
  const events = await stack.db
    .select()
    .from(schema.crmEvents)
    .where(
      and(
        eq(schema.crmEvents.companyId, companyId),
        eq(schema.crmEvents.dedupeKey, `contract_ended:${contract!.id}`),
      ),
    );
  expect(events).toHaveLength(1);
  beaSocket.close();
}, 60_000);
