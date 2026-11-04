// Billing reads and writes (ADR 0015). Subscriptions are written by Better Auth's Stripe plugin
// and, when its webhook missed something, by the daily reconcile; this file reads them, counts
// AI-triaged emails against the monthly allowance, and remembers which Stripe events were
// applied. Trusted code: callers have already resolved the workspace.
import { and, count, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { organizations, subscriptions } from "./schema/auth.ts";
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

/**
 * The subscription fields Stripe owns, in the plugin's shape: what its `customer.subscription.*`
 * handlers write from a Stripe subscription, and what the reconcile writes from the same object.
 */
export interface StripeSubscriptionFields {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  /** Absent when Stripe has no trial; like the plugin, a missing trial never clears one. */
  trialStart?: Date;
  trialEnd?: Date;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  canceledAt: Date | null;
  endedAt: Date | null;
  seats: number;
  billingInterval: string | null;
  stripeScheduleId: string | null;
  /** The plan's key, when the subscription's price is one of the plan's. Never cleared. */
  plan?: string;
}

const SYNCED_FIELDS = [
  "stripeSubscriptionId",
  "stripeCustomerId",
  "status",
  "periodStart",
  "periodEnd",
  "trialStart",
  "trialEnd",
  "cancelAtPeriodEnd",
  "cancelAt",
  "canceledAt",
  "endedAt",
  "seats",
  "billingInterval",
  "stripeScheduleId",
  "plan",
] as const satisfies readonly (keyof StripeSubscriptionFields)[];

export type SubscriptionRow = Awaited<ReturnType<typeof subscriptionRows>>[number];

/** Every subscription row, with the fields Stripe owns. One row or two per billed workspace. */
export async function subscriptionRows(db: Db) {
  return db
    .select({
      id: subscriptions.id,
      orgId: subscriptions.orgId,
      plan: subscriptions.plan,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      stripeCustomerId: subscriptions.stripeCustomerId,
      status: subscriptions.status,
      periodStart: subscriptions.periodStart,
      periodEnd: subscriptions.periodEnd,
      trialStart: subscriptions.trialStart,
      trialEnd: subscriptions.trialEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      cancelAt: subscriptions.cancelAt,
      canceledAt: subscriptions.canceledAt,
      endedAt: subscriptions.endedAt,
      seats: subscriptions.seats,
      billingInterval: subscriptions.billingInterval,
      stripeScheduleId: subscriptions.stripeScheduleId,
    })
    .from(subscriptions)
    .orderBy(subscriptions.id);
}

/** A subscription that ended in Stripe and can no longer change there. */
export function isSettled(row: Pick<SubscriptionRow, "status" | "endedAt">) {
  return row.status === "canceled" && row.endedAt !== null;
}

/** Workspaces that are Stripe customers (the plugin sets the id at their first checkout). */
export async function billedWorkspaces(db: Db) {
  const rows = await db
    .select({ orgId: organizations.id, stripeCustomerId: organizations.stripeCustomerId })
    .from(organizations)
    .where(isNotNull(organizations.stripeCustomerId))
    .orderBy(organizations.id);
  return rows as { orgId: string; stripeCustomerId: string }[];
}

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/**
 * Brings `row` in line with Stripe's `fields`, writing only what differs. False when it already
 * matched, so a second run changes nothing.
 */
export async function applyStripeSubscription(
  db: Db,
  row: SubscriptionRow,
  fields: StripeSubscriptionFields,
): Promise<boolean> {
  const changes: Partial<StripeSubscriptionFields> = {};
  for (const name of SYNCED_FIELDS) {
    const next = fields[name];
    if (next !== undefined && !same(row[name], next)) Object.assign(changes, { [name]: next });
  }
  if (Object.keys(changes).length === 0) return false;
  await db.update(subscriptions).set(changes).where(eq(subscriptions.id, row.id));
  return true;
}

/**
 * Creates the row for a Stripe subscription of `orgId` that Omni never heard of, the way the
 * plugin's `customer.subscription.created` handler does. False when a row for it exists already
 * (a concurrent run, or the webhook got there first). Serialized per Stripe subscription.
 */
export async function createStripeSubscription(
  db: Db,
  orgId: string,
  fields: StripeSubscriptionFields & { plan: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${fields.stripeSubscriptionId}, 0))`,
    );
    const [existing] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, fields.stripeSubscriptionId))
      .limit(1);
    if (existing) return false;
    await tx.insert(subscriptions).values({ id: uuidv7(), orgId, ...fields });
    return true;
  });
}
