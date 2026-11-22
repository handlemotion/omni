import { usagePeriod } from "@omni/ai";
import {
  METERS,
  PLAN_LIMITS,
  type Cap,
  type Meter,
  type PlanKey,
  type PlanLimits,
} from "@omni/contracts";
import {
  capUsage,
  claimUsage,
  planOf,
  usageOf,
  workspaceSubscription,
  type Db,
  type WorkspaceSubscription,
} from "@omni/db";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./env.ts";
import { ApiFailure } from "./errors.ts";

/** The usage month `now` falls in, for meters and for Storage's peak; null with no period yet. */
export function period(subscription: WorkspaceSubscription, now: Date) {
  if (!subscription?.periodStart) return null;
  return usagePeriod(
    {
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      interval: subscription.billingInterval,
    },
    now,
  );
}

/** A Free workspace's usage month: the calendar month `now` is in, in UTC. */
export function calendarMonth(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export type Entitlements =
  | { enabled: false }
  | {
      enabled: true;
      plan: PlanKey;
      limits: PlanLimits;
      /** The subscription the plan comes from; null on Free with none, or the lapsed one. */
      subscription: WorkspaceSubscription;
      /** The usage month meters count in now. */
      month: { start: Date; end: Date };
    };

/**
 * What `orgId` may do now: the one place a workspace's plan is decided. A subscription in good
 * standing gives its plan (a paid one Omni cannot name is Team, the first plan); anything else,
 * lapsed or never paid, is Free. With billing off there is no plan and no limit.
 */
export const entitlements: (
  db: Db,
  config: Config,
  orgId: string,
  now?: Date,
) => Promise<Entitlements> = async (db, config, orgId, now = new Date()) => {
  if (!config.auth.billing) return { enabled: false };
  const subscription = await workspaceSubscription(db, orgId);
  const plan = planOf(subscription);
  const month = (plan !== "free" ? period(subscription, now) : null) ?? calendarMonth(now);
  return { enabled: true, plan, limits: PLAN_LIMITS[plan], subscription, month };
};

const CAP_NAMES = {
  members: "members",
  mailboxes: "inboxes",
  domains: "domains",
  crmRecords: "CRM records",
  storageGb: "GB of storage",
} as const satisfies Record<Cap, string>;

/**
 * Why the plan holds no more of `cap` (adding `adding`), or null when it has room. Nothing
 * already held is ever taken away: a workspace over a cap (after a downgrade) keeps it all and
 * only adds once back under.
 */
export async function capRefusal(db: Db, config: Config, orgId: string, cap: Cap, adding = 1) {
  const plan = await entitlements(db, config, orgId);
  if (!plan.enabled) return null;
  const max: number | null = plan.limits[cap];
  if (max === null) return null;
  const held = await capUsage(db, orgId, cap);
  if (held + adding <= max) return null;
  return {
    message: `this workspace's plan holds ${max} ${CAP_NAMES[cap]}; move to a bigger plan for more`,
    details: { cap, max, held, plan: plan.plan },
  };
}

/** The most of `cap` the plan holds, or null for no limit (or billing off). */
export async function capMax(db: Db, config: Config, orgId: string, cap: Cap) {
  const plan = await entitlements(db, config, orgId);
  const max: number | null = plan.enabled ? plan.limits[cap] : null;
  return max;
}

/** Refuses (`402 plan_limit`) adding `adding` more of `cap` when the plan holds no more. */
export async function requireCap(db: Db, config: Config, orgId: string, cap: Cap, adding = 1) {
  const refusal = await capRefusal(db, config, orgId, cap, adding);
  if (refusal) throw new ApiFailure("plan_limit", refusal.message, { details: refusal.details });
}

export type MeterGate =
  | { run: true }
  | { run: false; reason: "plan_required" }
  | { run: false; reason: "allowance_reached"; until: Date };

/**
 * Whether costly work on `key` may run now, taking `amount` of the month's `meter` when it may.
 * A key counted before runs again free (a retried job). `always` counts it whatever is left: for
 * work already done that the workspace was allowed to start. Called only when the cost is real;
 * work that calls no model never counts.
 */
export async function gateMeter(
  db: Db,
  config: Config,
  input: { orgId: string; meter: Meter; key: string; amount?: number; always?: boolean },
  now = new Date(),
) {
  const plan = await entitlements(db, config, input.orgId, now);
  if (!plan.enabled) return { run: true } satisfies MeterGate as MeterGate;
  const allowance = plan.limits[input.meter];
  if (allowance === 0 && !input.always) {
    return { run: false, reason: "plan_required" } satisfies MeterGate as MeterGate;
  }
  const claim = await claimUsage(db, {
    orgId: input.orgId,
    periodStart: plan.month.start,
    meter: input.meter,
    key: input.key,
    amount: input.amount,
    allowance,
    always: input.always,
  });
  const gate: MeterGate =
    claim === "over"
      ? { run: false, reason: "allowance_reached", until: plan.month.end }
      : { run: true };
  return gate;
}

/** `gateMeter` for a route: refuses with `402` instead of answering why not. */
export async function requireMeter(
  db: Db,
  config: Config,
  input: { orgId: string; meter: Meter; key: string; amount?: number },
) {
  const gate = await gateMeter(db, config, input);
  if (gate.run) return;
  if (gate.reason === "plan_required") {
    throw new ApiFailure("plan_required", "this needs a paid plan", {
      details: { feature: input.meter },
    });
  }
  throw new ApiFailure("allowance_reached", "this month's allowance is used up", {
    details: { meter: input.meter, resetsAt: gate.until.toISOString() },
  });
}

/**
 * Whether the plan has room for more of `meter` this month, without taking any: for work whose
 * cost is known only once it ends (a recording), which is counted then with `always`.
 */
export async function hasAllowance(db: Db, config: Config, orgId: string, meter: Meter) {
  const plan = await entitlements(db, config, orgId);
  if (!plan.enabled) return { ok: true as const };
  const allowance = plan.limits[meter];
  if (allowance === 0) return { ok: false as const, reason: "plan_required" as const };
  const used = await usageOf(db, orgId, plan.month.start, meter);
  return used < allowance
    ? { ok: true as const }
    : { ok: false as const, reason: "allowance_reached" as const, until: plan.month.end };
}

/** The month's use of every meter, for the Billing page. */
export async function monthUsage(db: Db, orgId: string, start: Date) {
  const entries = await Promise.all(
    METERS.map(async (meter) => [meter, await usageOf(db, orgId, start, meter)] as const),
  );
  return Object.fromEntries(entries) as Record<Meter, number>;
}

/**
 * Whether the model may triage `messageId` now, taking one unit of the month's allowance when it
 * may. Called only when a model would actually run; rule-filed threads cost nothing and never
 * count. A lapsed plan is Free, so triage never stops for billing alone.
 */
export const gateTriage: (
  db: Db,
  config: Config,
  input: { orgId: string; messageId: string },
  now?: Date,
) => Promise<MeterGate> = (db, config, input, now) =>
  gateMeter(db, config, { orgId: input.orgId, meter: "triage", key: input.messageId }, now);

export function requireBilling(config: Config) {
  const billing = config.auth.billing;
  if (!billing) throw new HTTPException(404, { message: "billing is not enabled" });
  return billing;
}
