// Billing reads and writes (ADR 0015). Subscriptions are written by Better Auth's Stripe plugin;
// this file reads them, counts AI-triaged emails against the monthly allowance, and remembers
// which Stripe events were applied. Trusted code: callers have already resolved the workspace.
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { subscriptions } from "./schema/auth.ts";
import { stripeEvents, threads, triageUsage } from "./schema/mail.ts";

/**
 * Stripe subscription statuses that keep a workspace fully usable. `past_due` is Stripe's grace
 * while it retries a failed payment; every other status (canceled, unpaid, incomplete, paused…)
 * leaves the workspace read-only.
 */
export const PAID_STATUSES = ["active", "trialing", "past_due"] as const;

export type WorkspaceSubscription = Awaited<ReturnType<typeof workspaceSubscription>>;

/**
 * The workspace's current subscription: the newest one in good standing, else the newest of
 * any status (to show why it is read-only), else null (never subscribed). Ids are UUIDv7, so
 * newest is the highest id.
 */
export async function workspaceSubscription(db: Db, orgId: string) {
  const rows = await db
    .select({
      id: subscriptions.id,
      plan: subscriptions.plan,
      status: subscriptions.status,
      billingInterval: subscriptions.billingInterval,
      periodStart: subscriptions.periodStart,
      periodEnd: subscriptions.periodEnd,
      trialEnd: subscriptions.trialEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
    })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .orderBy(desc(subscriptions.id));
  return rows.find((row) => isPaid(row.status)) ?? rows[0] ?? null;
}

export function isPaid(status: string) {
  return (PAID_STATUSES as readonly string[]).includes(status);
}

/** Emails AI-triaged in the workspace's usage month starting at `periodStart`. */
export async function triageUsageCount(db: Db, orgId: string, periodStart: Date) {
  const [row] = await db
    .select({ used: count() })
    .from(triageUsage)
    .where(and(eq(triageUsage.orgId, orgId), eq(triageUsage.periodStart, periodStart)));
  return row?.used ?? 0;
}

/**
 * Takes one unit of the month's allowance for `messageId` before the model is called.
 * `counted`: newly counted. `already`: this email was counted before (a retried or redelivered
 * job), so it may run again at no extra cost. `over`: the allowance is used up. Serialized per
 * workspace with a transaction-scoped advisory lock, so concurrent jobs cannot overshoot.
 */
export async function claimTriage(
  db: Db,
  input: { orgId: string; periodStart: Date; messageId: string; allowance: number },
): Promise<"counted" | "already" | "over"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.orgId}, 0))`);
    const where = and(
      eq(triageUsage.orgId, input.orgId),
      eq(triageUsage.periodStart, input.periodStart),
    );
    const [seen] = await tx
      .select({ messageId: triageUsage.messageId })
      .from(triageUsage)
      .where(and(where, eq(triageUsage.messageId, input.messageId)));
    if (seen) return "already";
    const [row] = await tx.select({ used: count() }).from(triageUsage).where(where);
    if ((row?.used ?? 0) >= input.allowance) return "over";
    await tx.insert(triageUsage).values({
      orgId: input.orgId,
      periodStart: input.periodStart,
      messageId: input.messageId,
    });
    return "counted";
  });
}

/** Records why the thread's latest message went untriaged: the allowance resets at `until`. */
export async function markTriagePaused(db: Db, threadId: string, until: Date) {
  await db
    .update(threads)
    .set({ triagePausedUntil: until, updatedAt: new Date() })
    .where(eq(threads.id, threadId));
}

export interface StripeEventRef {
  id: string;
  type: string;
  objectId: string | null;
  orgId: string | null;
  createdAt: Date;
}

/**
 * Whether a verified Stripe event should be applied. `duplicate`: this exact event was applied
 * (Stripe retries, or a replay). `stale`: a newer event about the same object was applied, and
 * this one's snapshot would roll it back. Stripe timestamps are whole seconds, so events from the
 * same second all apply.
 */
export async function stripeEventDisposition(
  db: Db,
  event: StripeEventRef,
): Promise<"new" | "duplicate" | "stale"> {
  const [seen] = await db
    .select({ id: stripeEvents.id })
    .from(stripeEvents)
    .where(eq(stripeEvents.id, event.id));
  if (seen) return "duplicate";
  if (!event.objectId) return "new";
  const [newer] = await db
    .select({ id: stripeEvents.id })
    .from(stripeEvents)
    .where(
      and(
        eq(stripeEvents.objectId, event.objectId),
        gt(stripeEvents.eventCreatedAt, event.createdAt),
      ),
    )
    .limit(1);
  return newer ? "stale" : "new";
}

/**
 * Stored subscriptions matching one key, the way Better Auth's Stripe plugin finds the row an
 * event writes: by our id (from the Stripe object's metadata), by Stripe's subscription id, or by
 * Stripe customer.
 */
export async function storedSubscriptions(
  db: Db,
  key: { id: string } | { stripeSubscriptionId: string } | { stripeCustomerId: string },
) {
  const where =
    "id" in key
      ? eq(subscriptions.id, key.id)
      : "stripeSubscriptionId" in key
        ? eq(subscriptions.stripeSubscriptionId, key.stripeSubscriptionId)
        : eq(subscriptions.stripeCustomerId, key.stripeCustomerId);
  return db
    .select({ id: subscriptions.id, status: subscriptions.status })
    .from(subscriptions)
    .where(where);
}

/** Marks an event applied (or deliberately skipped). Idempotent. */
export async function recordStripeEvent(db: Db, event: StripeEventRef) {
  await db
    .insert(stripeEvents)
    .values({
      id: event.id,
      type: event.type,
      objectId: event.objectId,
      orgId: event.orgId,
      eventCreatedAt: event.createdAt,
    })
    .onConflictDoNothing();
}
