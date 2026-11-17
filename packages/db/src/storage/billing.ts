import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { PAID_STATUSES } from "../billing.ts";
import type { Db } from "../client.ts";
import { isCompany } from "../personal-space.ts";
import { organizations, subscriptions } from "../schema/auth.ts";
import { storageOverage, storagePeaks, storageUsage } from "../schema/storage.ts";

/**
 * Raises the peak of the usage month starting at `periodStart` to `bytes` if that is more, and
 * returns the peak. It never goes down within a month, a new month starts from what is stored
 * then, and running it twice changes nothing.
 */
export async function raiseStoragePeak(
  db: Db,
  input: { orgId: string; periodStart: Date; bytes: number },
) {
  const [row] = await db
    .insert(storagePeaks)
    .values({ orgId: input.orgId, periodStart: input.periodStart, peakBytes: input.bytes })
    .onConflictDoUpdate({
      target: [storagePeaks.orgId, storagePeaks.periodStart],
      set: { peakBytes: sql`greatest(${storagePeaks.peakBytes}, excluded.peak_bytes)` },
    })
    .returning({ peakBytes: storagePeaks.peakBytes });
  return row!.peakBytes;
}

/** The recorded peak of the usage month starting at `periodStart`; 0 when none is recorded. */
export async function storagePeakOf(db: Db, orgId: string, periodStart: Date) {
  const [row] = await db
    .select({ peakBytes: storagePeaks.peakBytes })
    .from(storagePeaks)
    .where(and(eq(storagePeaks.orgId, orgId), eq(storagePeaks.periodStart, periodStart)));
  return row?.peakBytes ?? 0;
}

/**
 * Records that Stripe showed `stripeSubscriptionId` with a payment method, or (null) that it
 * showed the workspace's subscription without one. Idempotent.
 */
export async function setStorageOverage(
  db: Db,
  orgId: string,
  stripeSubscriptionId: string | null,
) {
  if (stripeSubscriptionId === null) {
    await db.delete(storageOverage).where(eq(storageOverage.orgId, orgId));
    return;
  }
  await db
    .insert(storageOverage)
    .values({ orgId, stripeSubscriptionId })
    .onConflictDoUpdate({
      target: storageOverage.orgId,
      set: { stripeSubscriptionId, checkedAt: new Date() },
    });
}

/** The subscription Stripe last showed with a payment method for `orgId`, or null. */
export async function storageOverageOf(db: Db, orgId: string) {
  const [row] = await db
    .select({ stripeSubscriptionId: storageOverage.stripeSubscriptionId })
    .from(storageOverage)
    .where(eq(storageOverage.orgId, orgId));
  return row?.stripeSubscriptionId ?? null;
}

/**
 * From a Stripe subscription event that carries a payment method: records it for the workspace
 * whose customer it is. False when the customer is no workspace's.
 */
export async function noteSubscriptionPaymentMethod(
  db: Db,
  input: { stripeCustomerId: string; stripeSubscriptionId: string },
) {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.stripeCustomerId, input.stripeCustomerId));
  if (!org) return false;
  await setStorageOverage(db, org.id, input.stripeSubscriptionId);
  return true;
}

export type StorageBilledWorkspace = Awaited<ReturnType<typeof storageBilledWorkspaces>>[number];

/**
 * Every company with a subscription in good standing, with what it stores now: the workspaces
 * the daily job records a peak for. One row per workspace, its newest such subscription, as
 * `workspaceSubscription` picks it.
 */
export async function storageBilledWorkspaces(db: Db) {
  const rows = await db
    .select({
      orgId: subscriptions.orgId,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      stripeScheduleId: subscriptions.stripeScheduleId,
      status: subscriptions.status,
      billingInterval: subscriptions.billingInterval,
      periodStart: subscriptions.periodStart,
      periodEnd: subscriptions.periodEnd,
      bytes: sql<number>`coalesce(${storageUsage.bytes}, 0)`.mapWith(Number),
    })
    .from(subscriptions)
    .innerJoin(organizations, eq(organizations.id, subscriptions.orgId))
    .leftJoin(storageUsage, eq(storageUsage.orgId, subscriptions.orgId))
    .where(and(inArray(subscriptions.status, PAID_STATUSES), isCompany(db, subscriptions.orgId)))
    .orderBy(subscriptions.orgId, desc(subscriptions.id));
  return rows.filter((row, i) => row.orgId !== rows[i - 1]?.orgId);
}
