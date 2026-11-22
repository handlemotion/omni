import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { members, organizations, storagePeaks, subscriptions } from "../src/schema/index.ts";
import {
  noteSubscriptionPaymentMethod,
  purgeStorageTrash,
  raiseStoragePeak,
  setStorageOverage,
  storageBilledWorkspaces,
  storageOverageOf,
  storagePeakOf,
  storageUsageOf,
} from "../src/storage.ts";
import { addFile } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

async function subscribe(orgId: string, status: string, stripeSubscriptionId?: string) {
  const [row] = await db
    .insert(subscriptions)
    .values({ id: randomUUID(), plan: "omni", orgId, status, stripeSubscriptionId })
    .returning();
  return row!;
}

test("a month's peak only rises, a new month starts from what is stored then, and a rerun changes nothing", async () => {
  const org = await createOrg(db, "peaks");
  const march = new Date("2026-03-05T10:00:00Z");
  const april = new Date("2026-04-05T10:00:00Z");
  const raise = (periodStart: Date, bytes: number) =>
    raiseStoragePeak(db, { orgId: org.id, periodStart, bytes });

  expect(await storagePeakOf(db, org.id, march)).toBe(0);
  expect(await raise(march, 500)).toBe(500);
  expect(await raise(march, 900)).toBe(900);
  expect(await raise(march, 100)).toBe(900);
  expect(await raise(march, 100)).toBe(900);
  expect(await storagePeakOf(db, org.id, march)).toBe(900);

  expect(await raise(april, 100)).toBe(100);
  expect(await storagePeakOf(db, org.id, march)).toBe(900);
  const rows = await db.select().from(storagePeaks).where(eq(storagePeaks.orgId, org.id));
  expect(rows).toHaveLength(2);
});

test("the purge keeps a read-only workspace's Trash and empties everyone else's", async () => {
  const before = new Date(Date.now() + 60_000);
  async function trashed(orgId: string, memberId: string) {
    const storage = forMember(db, memberId).storage;
    const file = await addFile(storage, { space: "personal" }, "old.bin", 40);
    expect((await storage.trash(file.id)).status).toBe("ok");
    return file;
  }
  const lapsed = await createOrg(db, "lapsed");
  await subscribe(lapsed.id, "canceled");
  const never = await createOrg(db, "never-subscribed");
  const paying = await createOrg(db, "paying");
  await subscribe(paying.id, "canceled");
  await subscribe(paying.id, "past_due");
  const companies = [lapsed, never, paying];
  for (const org of companies) await trashed(org.id, (await createMember(db, org.id, "ana")).id);
  const solo = await createMember(db, lapsed.id, "solo");
  const space = await ensurePersonalSpace(db, solo.userId);
  const [own] = await db.select().from(members).where(eq(members.organizationId, space));
  await trashed(space, own!.id);

  const bytes = async () =>
    Promise.all(
      [...companies.map((org) => org.id), space].map(
        async (id) => (await storageUsageOf(db, id)).bytes,
      ),
    );
  for (let run = 0; run < 2; run++) {
    const purged = await purgeStorageTrash(db, { before, keepReadOnly: true });
    expect(purged.more).toBe(false);
    expect(await bytes()).toEqual([40, 40, 0, 0]);
  }
  await subscribe(lapsed.id, "active");
  await purgeStorageTrash(db, { before, keepReadOnly: true });
  expect(await bytes()).toEqual([0, 40, 0, 0]);
  await purgeStorageTrash(db, { before });
  expect(await bytes()).toEqual([0, 0, 0, 0]);
});

test("a payment method is recorded for the customer's workspace only, and the daily job sees each paying company once", async () => {
  const acme = await createOrg(db, "acme");
  const other = await createOrg(db, "other");
  await db
    .update(organizations)
    .set({ stripeCustomerId: "cus_acme" })
    .where(eq(organizations.id, acme.id));
  expect(
    await noteSubscriptionPaymentMethod(db, {
      stripeCustomerId: "cus_nobody",
      stripeSubscriptionId: "sub_x",
    }),
  ).toBe(false);
  for (let run = 0; run < 2; run++) {
    expect(
      await noteSubscriptionPaymentMethod(db, {
        stripeCustomerId: "cus_acme",
        stripeSubscriptionId: "sub_acme",
      }),
    ).toBe(true);
  }
  expect(await storageOverageOf(db, acme.id)).toBe("sub_acme");
  expect(await storageOverageOf(db, other.id)).toBeNull();
  await setStorageOverage(db, acme.id, null);
  expect(await storageOverageOf(db, acme.id)).toBeNull();

  await subscribe(acme.id, "canceled", "sub_old");
  await subscribe(acme.id, "active", "sub_acme");
  await subscribe(other.id, "canceled", "sub_gone");
  const ana = await createMember(db, acme.id, "ana");
  await addFile(forMember(db, ana.id).storage, { space: "shared" }, "a.bin", 70);
  const space = await ensurePersonalSpace(db, ana.userId);
  await subscribe(space, "active", "sub_personal");

  const mine = (await storageBilledWorkspaces(db)).filter((row) =>
    [acme.id, other.id, space].includes(row.orgId),
  );
  expect(mine).toEqual([
    expect.objectContaining({
      orgId: acme.id,
      stripeCustomerId: "cus_acme",
      stripeSubscriptionId: "sub_acme",
      status: "active",
      bytes: 70,
    }),
  ]);
});
