import { randomBytes, randomUUID } from "node:crypto";
import { usagePeriod } from "@omni/ai";
import { schema, storageObjectKey } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIB, startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import {
  BILLING_SECRETS,
  MONTHLY_PRICE,
  postStripeEvent,
  stripeEvent,
  subscriptionObject,
  YEARLY_PRICE,
} from "./stripe-events.ts";
import { CookieJar, signIn } from "./support.ts";

const GIB = 1024 ** 3;
const DAY_MS = 86_400_000;
const ALLOWANCE = 2 * MIB;
const CEILING = 5 * MIB;
const PERSONAL = MIB;

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      STRIPE_PRICE_YEARLY: YEARLY_PRICE,
      BILLING_TRIAGE_ALLOWANCE: "500",
      BILLING_STORAGE_INCLUDED_GB: String(ALLOWANCE / GIB),
      STRIPE_PRICE_STORAGE: "price_e2e_storage",
      STRIPE_STORAGE_METER_EVENT: "omni_e2e_storage_gb",
      STORAGE_MAX_GB: String(CEILING / GIB),
      STORAGE_PERSONAL_GB: String(PERSONAL / GIB),
    },
    secrets: BILLING_SECRETS,
  });
});
afterAll(() => stack?.stop());

interface Plan {
  status: string;
  interval?: "month" | "year";
  stripeId?: string;
  cardOn?: string;
  periodStart?: Date;
  periodEnd?: Date;
}

async function company(plan: Plan | null) {
  const org = await stack.company(`co-${randomUUID().slice(0, 8)}`);
  if (plan) {
    await stack.db.insert(schema.subscriptions).values({
      id: randomUUID(),
      plan: "omnipresent",
      orgId: org.id,
      status: plan.status,
      billingInterval: plan.interval ?? "month",
      stripeSubscriptionId: plan.stripeId,
      periodStart: plan.periodStart ?? new Date(Date.now() - 10 * DAY_MS),
      periodEnd: plan.periodEnd ?? new Date(Date.now() + 20 * DAY_MS),
    });
    if (plan.cardOn) {
      await stack.db
        .insert(schema.storageOverage)
        .values({ orgId: org.id, stripeSubscriptionId: plan.cardOn });
    }
  }
  return { org, owner: await stack.member(org.id, "owner") };
}

const open = (person: { jar: CookieJar }, size: number, base = "", place: object = {}) =>
  stack.api(person.jar, "POST", `${base}/uploads`, {
    name: `${randomUUID().slice(0, 8)}.bin`,
    size,
    space: "shared",
    ...place,
  });
const usage = async (person: Person) => (await stack.api(person.jar, "GET", "/usage")).body;
const peaks = (orgId: string) =>
  stack.db.select().from(schema.storagePeaks).where(eq(schema.storagePeaks.orgId, orgId));

test("the daily job records each paying workspace's peak per usage month and leaves a read-only workspace's Trash alone", async () => {
  const bucket = await stack.bucket();
  const old = new Date(Date.now() - 31 * DAY_MS);
  async function withOldTrash(plan: Plan) {
    const { org, owner } = await company(plan);
    const file = await stack.upload(owner.jar, { space: "shared" }, "old.bin", randomBytes(300));
    expect((await stack.api(owner.jar, "DELETE", `/nodes/${file.id}`)).status).toBe(200);
    await stack.db
      .update(schema.storageNodes)
      .set({ trashedAt: old })
      .where(eq(schema.storageNodes.id, file.id));
    return { org, owner, file };
  }
  const paying = await withOldTrash({ status: "trialing" });
  const lapsed = await withOldTrash({ status: "trialing" });
  await stack.db
    .update(schema.subscriptions)
    .set({ status: "canceled" })
    .where(eq(schema.subscriptions.orgId, lapsed.org.id));

  const start = new Date(Date.now() - 10 * DAY_MS);
  const measured = await company({ status: "active", periodStart: start });
  const first = await stack.upload(
    measured.owner.jar,
    { space: "shared" },
    "first.bin",
    randomBytes(1000),
  );

  for (let run = 0; run < 2; run++) expect(await stack.cron("47 3 * * *")).toBe("ok");

  expect(await bucket.head(storageObjectKey(paying.org.id, paying.file.id))).toBeNull();
  expect(await stack.usedBytes(paying.org.id)).toBe(0);
  expect(await bucket.head(storageObjectKey(lapsed.org.id, lapsed.file.id))).not.toBeNull();
  expect(await stack.usedBytes(lapsed.org.id)).toBe(300);
  expect((await stack.api(lapsed.owner.jar, "GET", "/trash")).body.nodes).toEqual([
    expect.objectContaining({ id: lapsed.file.id }),
  ]);
  expect(await peaks(lapsed.org.id)).toEqual([]);
  expect(await peaks(measured.org.id)).toEqual([
    { orgId: measured.org.id, periodStart: start, peakBytes: 1000 },
  ]);

  await stack.api(measured.owner.jar, "DELETE", `/nodes/${first.id}`);
  await stack.api(measured.owner.jar, "DELETE", `/nodes/${first.id}?forever=1`);
  await stack.upload(measured.owner.jar, { space: "shared" }, "next.bin", randomBytes(200));
  expect(await stack.cron("47 3 * * *")).toBe("ok");
  expect(await peaks(measured.org.id)).toEqual([
    { orgId: measured.org.id, periodStart: start, peakBytes: 1000 },
  ]);

  const stale = {
    periodStart: new Date(Date.now() - 45 * DAY_MS),
    periodEnd: new Date(Date.now() - 15 * DAY_MS),
  };
  await stack.db
    .update(schema.subscriptions)
    .set(stale)
    .where(eq(schema.subscriptions.orgId, measured.org.id));
  const next = usagePeriod({ ...stale, interval: "month" }, new Date()).start;
  expect(next.getTime()).toBeGreaterThan(stale.periodStart.getTime());
  expect(await stack.cron("47 3 * * *")).toBe("ok");
  const rows = await peaks(measured.org.id);
  expect(rows.toSorted((a, b) => a.peakBytes - b.peakBytes)).toEqual([
    { orgId: measured.org.id, periodStart: next, peakBytes: 200 },
    { orgId: measured.org.id, periodStart: start, peakBytes: 1000 },
  ]);
});

test("the allowance caps a trial, a yearly plan and a workspace with no card; a paying monthly workspace with a card passes it, up to the ceiling", async () => {
  const capped: Plan[] = [
    { status: "trialing", stripeId: "sub_trial", cardOn: "sub_trial" },
    { status: "active", stripeId: "sub_nocard" },
    { status: "active", interval: "year", stripeId: "sub_year", cardOn: "sub_year" },
    { status: "active", stripeId: "sub_new", cardOn: "sub_replaced" },
  ];
  for (const plan of capped) {
    const { org, owner } = await company(plan);
    expect({ plan: plan.stripeId, status: (await open(owner, ALLOWANCE - 10)).status }).toEqual({
      plan: plan.stripeId,
      status: 201,
    });
    const over = await open(owner, 11);
    expect({ plan: plan.stripeId, ...over }).toMatchObject({
      plan: plan.stripeId,
      status: 402,
      body: { code: "STORAGE_FULL" },
    });
    expect(await usage(owner)).toEqual({
      usedBytes: 0,
      reservedBytes: ALLOWANCE - 10,
      limitBytes: ALLOWANCE,
      allowanceBytes: ALLOWANCE,
      overage: null,
      uploadsBlocked: null,
    });
    const uploads = await stack.db
      .select({ size: schema.storageUploads.size })
      .from(schema.storageUploads)
      .where(eq(schema.storageUploads.orgId, org.id));
    expect(uploads).toEqual([{ size: ALLOWANCE - 10 }]);
  }

  const start = new Date(Date.now() - 10 * DAY_MS);
  const paying = await company({
    status: "active",
    stripeId: "sub_paying",
    cardOn: "sub_paying",
    periodStart: start,
  });
  await stack.upload(paying.owner.jar, { space: "shared" }, "big.bin", randomBytes(ALLOWANCE + 1));
  expect(await usage(paying.owner)).toEqual({
    usedBytes: ALLOWANCE + 1,
    reservedBytes: 0,
    limitBytes: CEILING,
    allowanceBytes: ALLOWANCE,
    overage: { extraGb: 0 },
    uploadsBlocked: null,
  });
  expect((await open(paying.owner, CEILING - ALLOWANCE)).status).toBe(402);
  expect((await open(paying.owner, CEILING - ALLOWANCE - 1)).status).toBe(201);

  const peak = (peakBytes: number) =>
    stack.db
      .insert(schema.storagePeaks)
      .values({ orgId: paying.org.id, periodStart: start, peakBytes })
      .onConflictDoUpdate({
        target: [schema.storagePeaks.orgId, schema.storagePeaks.periodStart],
        set: { peakBytes },
      });
  await peak(ALLOWANCE + 3 * GIB - 1);
  expect((await usage(paying.owner)).overage).toEqual({ extraGb: 2 });
  await peak(ALLOWANCE + 3 * GIB);
  expect((await usage(paying.owner)).overage).toEqual({ extraGb: 3 });

  await stack.db
    .update(schema.subscriptions)
    .set({ status: "past_due" })
    .where(eq(schema.subscriptions.orgId, paying.org.id));
  expect((await usage(paying.owner)).limitBytes).toBe(CEILING);

  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, `solo-${randomUUID().slice(0, 8)}@personal.test`, jar);
  expect((await stack.api(jar, "GET", "/usage")).body).toMatchObject({
    limitBytes: PERSONAL,
    allowanceBytes: null,
    overage: null,
  });
  const none = await company(null);
  expect(await usage(none.owner)).toMatchObject({
    limitBytes: ALLOWANCE,
    uploadsBlocked: "billing_inactive",
  });
});

test("an editor's upload into a shared folder is held to the limit of the folder's workspace", async () => {
  const host = await company({ status: "trialing" });
  const guestHome = await company({ status: "active", stripeId: "sub_guest", cardOn: "sub_guest" });
  const folder = (
    await stack.api(host.owner.jar, "POST", "/folders", { name: "Inbox", space: "shared" })
  ).body.node;
  const shared = await stack.api(
    host.owner.jar,
    "PUT",
    `/nodes/${folder.id}/sharing/people/${encodeURIComponent(guestHome.owner.email)}`,
    { role: "editor" },
  );
  expect(shared.status).toBe(200);
  const door = `/shared/${shared.body.sharing.shareId}`;
  const into = { space: undefined, parentId: folder.id };

  expect((await open(guestHome.owner, ALLOWANCE + 1, door, into)).body).toMatchObject({
    code: "STORAGE_FULL",
  });
  expect((await open(guestHome.owner, ALLOWANCE, door, into)).status).toBe(201);
  expect((await open(guestHome.owner, ALLOWANCE + 1)).status).toBe(201);
});

test("a subscription event that carries a payment method lets the workspace pass the allowance at once", async () => {
  const { org, owner } = await company(null);
  const customer = `cus_e2e_${randomUUID().slice(0, 8)}`;
  await stack.db
    .update(schema.organizations)
    .set({ stripeCustomerId: customer })
    .where(eq(schema.organizations.id, org.id));
  const t0 = new Date(Date.now() - 60_000);
  const event = (
    type: "created" | "updated",
    status: "trialing" | "active",
    at: number,
    card: string | null,
  ) =>
    postStripeEvent(
      stack.worker.url,
      stripeEvent(
        `customer.subscription.${type}`,
        {
          ...subscriptionObject({
            id: `sub_e2e_${org.id.slice(0, 8)}`,
            customer,
            status,
            periodStart: t0,
            periodEnd: new Date(t0.getTime() + 30 * DAY_MS),
          }),
          default_payment_method: card,
        },
        new Date(t0.getTime() + at * 1000),
      ),
    );

  expect((await event("created", "trialing", 0, null)).body).toMatchObject({ applied: true });
  expect((await open(owner, ALLOWANCE + 1)).status).toBe(402);
  expect((await event("updated", "trialing", 10, "pm_e2e_card")).body).toMatchObject({
    applied: true,
  });
  expect((await open(owner, ALLOWANCE + 1)).status).toBe(402);
  expect((await event("updated", "active", 20, "pm_e2e_card")).body).toMatchObject({
    applied: true,
  });
  expect((await open(owner, ALLOWANCE + 1)).status).toBe(201);
  expect(await usage(owner)).toMatchObject({ limitBytes: CEILING, overage: { extraGb: 0 } });

  const sub = subscriptionObject({
    id: `sub_e2e_${org.id.slice(0, 8)}`,
    customer,
    status: "active",
    periodStart: t0,
    periodEnd: new Date(t0.getTime() + 30 * DAY_MS),
  });
  const plan = sub.items.data[0]!;
  const metered = {
    ...plan,
    id: `si_storage_${randomUUID().slice(0, 8)}`,
    quantity: undefined,
    price: { ...plan.price, id: "price_e2e_storage", recurring: { interval: "month" } },
  };
  const twoItems = stripeEvent(
    "customer.subscription.updated",
    {
      ...sub,
      default_payment_method: "pm_e2e_card",
      items: { ...sub.items, data: [metered, plan] },
    },
    new Date(t0.getTime() + 30_000),
  );
  expect((await postStripeEvent(stack.worker.url, twoItems)).body).toMatchObject({
    applied: true,
  });
  const [row] = await stack.db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.orgId, org.id));
  expect(row).toMatchObject({ plan: "omnipresent", status: "active", billingInterval: "month" });
  expect((await usage(owner)).limitBytes).toBe(CEILING);
});
