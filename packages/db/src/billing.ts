import { and, count, desc, eq, gt, isNotNull, notExists, or, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { organizations, subscriptions } from "./schema/auth.ts";
import { planKeyOf, type Meter, type PlanKey } from "@omni/contracts";
import { stripeEvents, trialClaims, triageUsage, usageClaims } from "./schema/billing.ts";

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
      stripeScheduleId: subscriptions.stripeScheduleId,
    })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .orderBy(desc(subscriptions.id));
  return rows.find((row) => isPaid(row.status)) ?? rows[0] ?? null;
}

/**
 * Why `userId` cannot start a free trial for `orgId`, or null when they can. A workspace gets one
 * trial, and so does an account: `workspace` when this workspace had one (a past subscription
 * with a trial, or a claim), `account` when this person started one for another workspace.
 */
export const trialUnavailable: (
  db: Db,
  input: { orgId: string; userId: string },
) => Promise<"workspace" | "account" | null> = async (db, input) => {
  const [trialed] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.orgId, input.orgId),
        or(
          isNotNull(subscriptions.trialStart),
          isNotNull(subscriptions.trialEnd),
          eq(subscriptions.status, "trialing"),
        ),
      ),
    )
    .limit(1);
  if (trialed) return "workspace";
  return otherClaim(db, input);
};

/**
 * Takes the trial of both the workspace and the account before Stripe is asked for it, so two
 * requests at once (two tabs, two workspaces) cannot both start one. Null when the claim is
 * theirs, new or left by an earlier attempt at the same start (so a retry goes on); otherwise why
 * not.
 */
export async function claimTrial(db: Db, input: { orgId: string; userId: string }) {
  await db.insert(trialClaims).values(input).onConflictDoNothing();
  return otherClaim(db, input);
}

async function otherClaim(db: Db, input: { orgId: string; userId: string }) {
  const claims = await db
    .select({ orgId: trialClaims.orgId, userId: trialClaims.userId })
    .from(trialClaims)
    .where(or(eq(trialClaims.orgId, input.orgId), eq(trialClaims.userId, input.userId)));
  const others = claims.filter((c) => c.orgId !== input.orgId || c.userId !== input.userId);
  if (others.some((c) => c.orgId === input.orgId)) return "workspace" as const;
  if (others.length > 0) return "account" as const;
  return null;
}

export function isPaid(status: string) {
  return (PAID_STATUSES as readonly string[]).includes(status);
}

/**
 * The plan a workspace's current subscription gives: its plan while in good standing, a trial
 * included (a paid one Omni cannot name is Team, the first plan), else null: no plan, so the
 * workspace is read-only. The one place this is decided.
 */
export function planOf(
  subscription: Pick<NonNullable<WorkspaceSubscription>, "status" | "plan"> | null,
) {
  const plan: PlanKey | null =
    subscription && isPaid(subscription.status) ? (planKeyOf(subscription.plan) ?? "team") : null;
  return plan;
}

/** `planOf` the workspace's current subscription. */
export async function workspacePlan(db: Db, orgId: string) {
  return planOf(await workspaceSubscription(db, orgId));
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
export const stripeEventDisposition: (
  db: Db,
  event: StripeEventRef,
) => Promise<"new" | "duplicate" | "stale"> = async (db, event) => {
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
};

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
  return subscriptionSelect(db).orderBy(subscriptions.id);
}

/** The row of one Stripe subscription, with the fields Stripe owns, or undefined. */
export async function subscriptionRowFor(db: Db, stripeSubscriptionId: string) {
  const [row] = await subscriptionSelect(db).where(
    eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId),
  );
  return row;
}

function subscriptionSelect(db: Db) {
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
    .$dynamic();
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
) {
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
) {
  return db.transaction<boolean>(async (tx) => {
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

const METER_COLUMN = {
  triage: "triage",
  assist: "assist",
  meetingMinutes: "meeting_minutes",
} as const satisfies Record<Meter, (typeof usageClaims.meter.enumValues)[number]>;

type Executor = Pick<Db, "select">;

/**
 * What the workspace used of `meter` in the usage month starting at `periodStart`. Triage also
 * counts the month's `triage_usage` rows, written before `usage_claims`, once each.
 */
export async function usageOf(db: Executor, orgId: string, periodStart: Date, meter: Meter) {
  const [row] = await db
    .select({ used: sql<number>`coalesce(sum(${usageClaims.amount}), 0)`.mapWith(Number) })
    .from(usageClaims)
    .where(
      and(
        eq(usageClaims.orgId, orgId),
        eq(usageClaims.periodStart, periodStart),
        eq(usageClaims.meter, METER_COLUMN[meter]),
      ),
    );
  if (meter !== "triage") return row?.used ?? 0;
  const [legacy] = await db
    .select({ used: count() })
    .from(triageUsage)
    .where(
      and(
        eq(triageUsage.orgId, orgId),
        eq(triageUsage.periodStart, periodStart),
        notExists(
          db
            .select({ one: sql`1` })
            .from(usageClaims)
            .where(
              and(
                eq(usageClaims.orgId, triageUsage.orgId),
                eq(usageClaims.periodStart, triageUsage.periodStart),
                eq(usageClaims.meter, "triage"),
                eq(usageClaims.key, triageUsage.messageId),
              ),
            ),
        ),
      ),
    );
  return (row?.used ?? 0) + (legacy?.used ?? 0);
}

export interface UsageClaim {
  orgId: string;
  periodStart: Date;
  meter: Meter;
  /** What is being used up; the same key never counts twice in a month. */
  key: string;
  amount?: number;
  /** The month's allowance. A claim that would pass it is refused, unless `always`. */
  allowance: number;
  /**
   * Count it even past the allowance: for work already done that the workspace was allowed to
   * start (a recording's minutes, known only once it ends).
   */
  always?: boolean;
}

/**
 * Takes `amount` of the month's allowance of `meter` for `key` before the costly work runs.
 * `counted`: newly counted. `already`: `key` was counted before (a retried or redelivered job),
 * so the work may run again at no extra cost. `over`: it would pass the allowance; nothing was
 * counted. Serialized per workspace and meter with a transaction-scoped advisory lock, so
 * concurrent jobs cannot overshoot, and safe to run twice.
 */
export async function claimUsage(db: Db, claim: UsageClaim) {
  const amount = claim.amount ?? 1;
  return db.transaction<"counted" | "already" | "over">(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`usage:${claim.orgId}:${claim.meter}`}, 0))`,
    );
    const column = METER_COLUMN[claim.meter];
    const [seen] = await tx
      .select({ key: usageClaims.key })
      .from(usageClaims)
      .where(
        and(
          eq(usageClaims.orgId, claim.orgId),
          eq(usageClaims.periodStart, claim.periodStart),
          eq(usageClaims.meter, column),
          eq(usageClaims.key, claim.key),
        ),
      );
    if (seen) return "already";
    if (claim.meter === "triage") {
      const [legacy] = await tx
        .select({ id: triageUsage.messageId })
        .from(triageUsage)
        .where(
          and(
            eq(triageUsage.orgId, claim.orgId),
            eq(triageUsage.periodStart, claim.periodStart),
            eq(triageUsage.messageId, claim.key),
          ),
        );
      if (legacy) return "already";
    }
    const used = await usageOf(tx, claim.orgId, claim.periodStart, claim.meter);
    if (!claim.always && used + amount > claim.allowance) return "over";
    await tx.insert(usageClaims).values({
      orgId: claim.orgId,
      periodStart: claim.periodStart,
      meter: column,
      key: claim.key,
      amount,
    });
    return "counted";
  });
}
