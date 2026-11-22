import { usagePeriod } from "@omni/ai";
import {
  METERS,
  PLAN_LIMITS,
  TRIAL_PLAN,
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
  workspaceKind,
  workspaceSubscription,
  type Db,
  type WorkspaceSubscription,
} from "@omni/db";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";
import type { Config } from "./env.ts";
import { ApiFailure, apiError } from "./errors.ts";

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

export type Entitlements =
  | { enabled: false }
  | {
      enabled: true;
      /** Null: no plan in good standing, so the workspace is read-only. */
      plan: PlanKey | null;
      /** The plan's limits; before it has one, the trial plan's, for setting up. */
      limits: PlanLimits;
      readOnly: boolean;
      /** The subscription the plan comes from, or the lapsed one, or null. */
      subscription: WorkspaceSubscription;
      /** The usage month meters count in now; null with no plan. */
      month: { start: Date; end: Date } | null;
    };

/**
 * What `orgId` may do now: the one place a workspace's plan is decided. A subscription in good
 * standing, a trial included, gives its plan; anything else leaves the workspace read-only until
 * it starts a trial or pays. A Personal space has no plan and no limit, and billing off has none.
 */
export const entitlements: (
  db: Db,
  config: Config,
  orgId: string,
  now?: Date,
) => Promise<Entitlements> = async (db, config, orgId, now = new Date()) => {
  if (!config.auth.billing || (await workspaceKind(db, orgId)) === "personal") {
    return { enabled: false };
  }
  const subscription = await workspaceSubscription(db, orgId);
  const plan = planOf(subscription);
  return {
    enabled: true,
    plan,
    limits: PLAN_LIMITS[plan ?? TRIAL_PLAN],
    readOnly: plan === null,
    subscription,
    month: plan === null ? null : period(subscription, now),
  };
};

const CAP_NAMES = {
  members: "members",
  mailboxes: "inboxes",
  domains: "domains",
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
  const max = plan.limits[cap];
  const held = await capUsage(db, orgId, cap);
  if (held + adding <= max) return null;
  return {
    message: `this workspace's plan holds ${max} ${CAP_NAMES[cap]}; move to a bigger plan for more`,
    details: { cap, max, held, plan: plan.plan },
  };
}

/** Refuses (`402 plan_limit`) adding `adding` more of `cap` when the plan holds no more. */
export async function requireCap(db: Db, config: Config, orgId: string, cap: Cap, adding = 1) {
  const refusal = await capRefusal(db, config, orgId, cap, adding);
  if (refusal) throw new ApiFailure("plan_limit", refusal.message, { details: refusal.details });
}

export type MeterGate =
  | { run: true }
  | { run: false; reason: "billing_inactive" }
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
  if (!plan.month)
    return { run: false, reason: "billing_inactive" } satisfies MeterGate as MeterGate;
  const allowance = plan.limits[input.meter];
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
  if (gate.reason === "billing_inactive") {
    throw new ApiFailure("billing_inactive", READ_ONLY_MESSAGE);
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
  if (!plan.month) return { ok: false as const, reason: "billing_inactive" as const };
  const used = await usageOf(db, orgId, plan.month.start, meter);
  return used < plan.limits[meter]
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
 * count. A workspace with no plan in good standing is not triaged at all.
 */
export const gateTriage: (
  db: Db,
  config: Config,
  input: { orgId: string; messageId: string },
  now?: Date,
) => Promise<MeterGate> = (db, config, input, now) =>
  gateMeter(db, config, { orgId: input.orgId, meter: "triage", key: input.messageId }, now);

/** A subscription in good standing (or billing off): the workspace may write and use AI. */
export async function inGoodStanding(db: Db, config: Config, orgId: string) {
  const plan = await entitlements(db, config, orgId);
  return !plan.enabled || !plan.readOnly;
}

/** What a write in a workspace without a plan in good standing is told (`billing_inactive`). */
export const READ_ONLY_MESSAGE = "this workspace is read-only until it has an active plan";

export const READ_ONLY_ALLOWED = [
  { path: "/api/billing", reason: "checkout and the portal are how a workspace becomes paid" },
  { path: "/api/workspace/members", reason: "giving a member an inbox is setup, not mail" },
  { path: "/api/workspace/shared-inboxes", reason: "who can see a mailbox is access, not mail" },
  { path: "/api/workspace/inboxes", reason: "who owns a former member's inbox is access" },
  { path: "/api/workspace/invitations", reason: "invitations stay open so an owner can fix it" },
  {
    path: "/api/push-tokens",
    reason: "a person's phone, not the workspace: signing out must stop pushes",
  },
  { path: "/api/auth", reason: "sign-in, invitations, organizations and Stripe's webhook" },
  { path: "/api/onboarding", reason: "workspace setup: domains and mailboxes" },
  { path: "/api/workspaces", reason: "which workspaces the user belongs to" },
  { path: "/api/join", reason: "asking to join a company, and the answer: membership, not mail" },
  { path: "/api/account", reason: "the person's own sign-in emails, not the workspace" },
  {
    path: "/api/storage/shared",
    reason: "gated in storage/shared.ts by the shared node's workspace, not the visitor's own",
  },
  {
    path: "/api/storage/signing",
    reason: "a signer answering a request already sent; sending one is gated",
  },
  {
    path: "/api/portal/projects/:id/deliverables/:id/review",
    reason: "a client answering a review the team already asked for; asking is gated",
  },
  {
    path: "/api/oauth",
    reason: "an agent's sign-in and its workspace choice: access, not mail",
  },
] as const satisfies readonly { path: string; reason: string }[];

export function allowedWhileReadOnly(path: string) {
  const segments = path.split("/");
  return READ_ONLY_ALLOWED.some((entry) => {
    const pattern = entry.path.split("/");
    return (
      segments.length >= pattern.length &&
      pattern.every((part, i) => part.startsWith(":") || part === segments[i])
    );
  });
}

/**
 * Every write under the member API needs a workspace in good standing unless `READ_ONLY_ALLOWED`
 * names it. Reads pass, so a read-only workspace keeps its mail visible and syncing.
 */
export const requireWritableWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  if (
    c.req.method !== "GET" &&
    c.req.method !== "HEAD" &&
    c.var.config.auth.billing &&
    !allowedWhileReadOnly(c.req.path)
  ) {
    if (!(await inGoodStanding(c.var.db, c.var.config, c.var.member.orgId))) {
      return apiError(c, "billing_inactive", READ_ONLY_MESSAGE);
    }
  }
  await next();
});

export function requireBilling(config: Config) {
  const billing = config.auth.billing;
  if (!billing) throw new HTTPException(404, { message: "billing is not enabled" });
  return billing;
}
